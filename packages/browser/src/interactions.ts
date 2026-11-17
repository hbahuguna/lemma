import { Buffer } from "node:buffer";

import {
  type ScenarioExecutionResult,
  type ScenarioPlan,
  type StepAction,
} from "@lemma/core";

import type { BrowserScenarioEvidenceStoreLike, BrowserScenarioPageLike } from "./scenarios.js";
import { executeScenarioPlan } from "./scenarios.js";

type CdpCall = (method: string, params?: any, sessionId?: string) => Promise<any>;

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function safeStr(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export interface CdpInteractionPageOptions {
  call: CdpCall;
  sessionId?: string;
  timeoutMs?: number;
  evidence?: BrowserScenarioEvidenceStoreLike;
  label?: string;
}

class CdpLocator {
  constructor(
    private readonly page: CdpInteractionPage,
    private readonly kind: "css" | "text" | "label" | "placeholder" | "role",
    private readonly query: string,
    private readonly role?: string,
  ) {}

  async count(): Promise<number> {
    const info = await this.page._find(this.kind, this.query, this.role);
    return info ? 1 : 0;
  }

  first(): CdpLocator {
    return this;
  }

  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.page._scrollIntoView(this.kind, this.query, this.role);
  }

  async click(): Promise<void> {
    await this.scrollIntoViewIfNeeded().catch(() => {});
    const ok = await this.page._click(this.kind, this.query, this.role);
    if (!ok) throw new Error(`Click failed for ${this.kind}:${this.query}`);
  }

  async fill(value: string): Promise<void> {
    await this.scrollIntoViewIfNeeded().catch(() => {});
    const ok = await this.page._fill(this.kind, this.query, this.role, value);
    if (!ok) throw new Error(`Fill failed for ${this.kind}:${this.query}`);
  }

  async dispatchEvent(_type: string): Promise<void> {
    // handled in _fill best-effort
  }

  async selectOption(value: unknown): Promise<void> {
    await this.scrollIntoViewIfNeeded().catch(() => {});
    const v = typeof value === "string" ? value : (value && typeof value === "object" ? safeStr((value as any).label || (value as any).value) : String(value ?? ""));
    const ok = await this.page._select(this.kind, this.query, v);
    if (!ok) throw new Error(`Select failed for ${this.kind}:${this.query}`);
  }
}

export class CdpInteractionPage implements BrowserScenarioPageLike {
  private readonly call: CdpCall;
  private readonly sessionId: string | undefined;
  constructor(opts: CdpInteractionPageOptions) {
    this.call = opts.call;
    this.sessionId = opts.sessionId;
  }

  async goto(url: string): Promise<void> {
    await this.call("Page.navigate", { url }, this.sessionId);
    await this.waitForTimeout(1200);
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  url(): string {
    // best-effort sync not possible; caller should use innerText/context. Provide empty; executeScenarioPlan uses page.url() in some asserts.
    return this._lastUrl;
  }
  private _lastUrl = "";

  async refreshUrl(): Promise<string> {
    try {
      const res = await this.evaluate("location.href");
      this._lastUrl = safeStr(res);
    } catch {}
    return this._lastUrl;
  }
  // BrowserScenarioPageLike compatibility
  [key: string]: unknown;

  async innerText(selector: string): Promise<string> {
    const expr = selector === "body"
      ? `(() => document.body?.innerText || document.body?.textContent || "")()`
      : `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? (el.innerText || el.textContent || "") : ""; })()`;
    const v = await this.evaluate(expr);
    return safeStr(v);
  }

  locator(selector: string): CdpLocator {
    return new CdpLocator(this, "css", selector);
  }
  getByText(text: string): CdpLocator {
    return new CdpLocator(this, "text", text);
  }
  getByRole(role: string, options?: Record<string, unknown>): CdpLocator {
    const name = safeStr(options?.name);
    return new CdpLocator(this, "role", name || "", role);
  }
  getByLabel(text: string): CdpLocator {
    return new CdpLocator(this, "label", text);
  }
  getByPlaceholder(text: string): CdpLocator {
    return new CdpLocator(this, "placeholder", text);
  }

  async screenshot(): Promise<Uint8Array | null> {
    try {
      const shot = await this.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, this.sessionId);
      if (shot?.data) return Buffer.from(String(shot.data), "base64");
    } catch {}
    return null;
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, this.sessionId);
    if (res?.exceptionDetails) {
      const msg = res.exceptionDetails?.text || res.exceptionDetails?.exception?.description || "Evaluation failed";
      throw new Error(String(msg));
    }
    return (res?.result?.value as T);
  }

  async _find(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "find");
    try { return Boolean(await this.evaluate(expr)); } catch { return false; }
  }
  async _scrollIntoView(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "scroll");
    try { return Boolean(await this.evaluate(expr)); } catch { return false; }
  }
  async _click(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "click");
    try { const ok = Boolean(await this.evaluate(expr)); await this.waitForTimeout(400); await this.refreshUrl(); return ok; } catch { return false; }
  }
  async _fill(kind: string, query: string, role: string | undefined, value: string): Promise<boolean> {
    const expr = buildFillExpr(kind, query, role, value);
    try { const ok = Boolean(await this.evaluate(expr)); await this.waitForTimeout(250); return ok; } catch { return false; }
  }
  async _select(kind: string, query: string, value: string): Promise<boolean> {
    const expr = buildSelectExpr(kind, query, value);
    try { const ok = Boolean(await this.evaluate(expr)); await this.waitForTimeout(250); return ok; } catch { return false; }
  }

  async scrollPage(direction: "top" | "bottom" | "down" | "up", amount = 800): Promise<void> {
    const expr =
      direction === "top" ? "window.scrollTo(0,0); true"
      : direction === "bottom" ? "window.scrollTo(0, document.body.scrollHeight); true"
      : direction === "down" ? `window.scrollBy(0, ${amount}); true`
      : `window.scrollBy(0, ${-amount}); true`;
    await this.evaluate(expr).catch(() => {});
    await this.waitForTimeout(250);
  }
}

function jsStr(s: string): string { return JSON.stringify(s ?? ""); }

function buildFindExpr(kind: string, query: string, role: string | undefined, mode: "find" | "scroll" | "click"): string {
  const q = jsStr(query);
  const r = jsStr(role || "");
  const action = mode === "find"
    ? "return true;"
    : mode === "scroll"
      ? "el.scrollIntoView({block:'center',inline:'center'}); return true;"
      : "el.click(); return true;";
  return `(() => {
    const isVisible = (el) => { if(!el) return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false; const rect=el.getBoundingClientRect(); return rect.width>0 && rect.height>0; };
    const pick = (els) => (Array.from(els||[])).find(isVisible) || (Array.from(els||[]))[0] || null;
    let el = null;
    const kind=${jsStr(kind)}, q=${q}, role=${r};
    const qStr = String(q||'');
    if (kind==='css') {
      try { el = qStr.startsWith('text=') ? pick(Array.from(document.querySelectorAll('*')).filter(n => (n.innerText||n.textContent||'').includes(qStr.slice(5)))) : pick(document.querySelectorAll(qStr)); } catch(e) { el=null; }
    }
    else if (kind==='text') { const t=qStr.toLowerCase(); el = pick(Array.from(document.querySelectorAll('a,button,[role="button"],[role="tab"],[role="switch"],label,summary,input[type="submit"],input[type="button"]')).filter(n => (n.innerText||n.textContent||n.value||n.getAttribute('aria-label')||'').toLowerCase().includes(t))); }
    else if (kind==='label') { const t=qStr.toLowerCase(); const labels=Array.from(document.querySelectorAll('label')).filter(l => (l.innerText||l.textContent||'').toLowerCase().includes(t)); for(const l of labels){ if(l.control && isVisible(l.control)){ el=l.control; break; } const id=l.getAttribute('for'); if(id){ const byId=document.getElementById(id); if(byId){ el=byId; break; } } } if(!el){ el=pick(Array.from(document.querySelectorAll('input,textarea,select')).filter(n => ((n.getAttribute('aria-label')||'')+ ' ' + (n.getAttribute('name')||'') + ' ' + (n.getAttribute('placeholder')||'')).toLowerCase().includes(t))); } }
    else if (kind==='placeholder') { const t=qStr.toLowerCase(); el = pick(Array.from(document.querySelectorAll('input,textarea')).filter(n => (n.getAttribute('placeholder')||'').toLowerCase().includes(t))); }
    else if (kind==='role') { const t=qStr.toLowerCase(); el = pick(Array.from(document.querySelectorAll('[role="'+role+'"], '+(role==='button'?'button,a,input[type="button"],input[type="submit"]':role==='tab'?'[role="tab"]':role==='switch'?'[role="switch"],input[type="checkbox"]':'*'))).filter(n => !t || (n.innerText||n.textContent||n.getAttribute('aria-label')||n.value||'').toLowerCase().includes(t))); }
    if (!el) return false;
    ${action}
  })()`;
}

function buildFillExpr(kind: string, query: string, _role: string | undefined, value: string): string {
  const q = jsStr(query); const v = jsStr(value);
  return `(() => {
    const isVisible = (el) => { if(!el) return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false; const rect=el.getBoundingClientRect(); return rect.width>0 && rect.height>0; };
    const pick = (els) => (Array.from(els||[])).find(isVisible) || (Array.from(els||[]))[0] || null;
    let el=null; const kind=${jsStr(kind)}, q=${q}, val=${v};
    if (kind==='css') { try { el = pick(document.querySelectorAll(q)); } catch(e) { el=null; } }
    else if (kind==='label') { const t=q.toLowerCase(); const labels=Array.from(document.querySelectorAll('label')).filter(l => (l.innerText||l.textContent||'').toLowerCase().includes(t)); for(const l of labels){ const lc:any = l; if(lc.control){ el=lc.control; break; } const id=l.getAttribute('for'); if(id){ const byId=document.getElementById(id); if(byId){ el=byId; break; } } } if(!el){ el=pick(Array.from(document.querySelectorAll('input,textarea,select')).filter(n => ((n.getAttribute('aria-label')||'')+' '+(n.getAttribute('name')||'')+' '+(n.getAttribute('placeholder')||'')).toLowerCase().includes(t))); } }
    else if (kind==='placeholder') { const t=q.toLowerCase(); el = pick(Array.from(document.querySelectorAll('input,textarea')).filter(n => (n.getAttribute('placeholder')||'').toLowerCase().includes(t))); }
    else if (kind==='text') { const t=q.toLowerCase(); el = pick(Array.from(document.querySelectorAll('input,textarea')).filter(n => ((n.getAttribute('aria-label')||'')+' '+(n.getAttribute('name')||'')+' '+(n.getAttribute('placeholder')||'')).toLowerCase().includes(t))); }
    if(!el) return false;
    el.focus && el.focus();
    if('value' in el){ el.value = val; } else { el.textContent = val; }
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`;
}

function buildSelectExpr(_kind: string, query: string, value: string): string {
  const q = jsStr(query); const v = jsStr(value);
  return `(() => {
    const isVisible = (el) => { if(!el) return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false; const rect=el.getBoundingClientRect(); return rect.width>0 && rect.height>0; };
    const pick = (els) => (Array.from(els||[])).find(isVisible) || (Array.from(els||[]))[0] || null;
    let el=null; const q=${q}, val=${v};
    try { el = pick(document.querySelectorAll(q)); } catch(e) {}
    if(!el){ const t=q.toLowerCase(); el = pick(Array.from(document.querySelectorAll('select')).filter(n => ((n.getAttribute('aria-label')||'')+' '+(n.getAttribute('name')||'')+' '+(n.id||'')).toLowerCase().includes(t))); }
    if(!el || el.tagName !== 'SELECT') return false;
    const opts = Array.from(el.options||[]);
    const match = opts.find(o => o.value===val || (o.text||'').trim()===val || (o.text||'').toLowerCase().includes(val.toLowerCase())) || opts[0];
    if(!match) return false;
    el.value = match.value;
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
    return true;
  })()`;
}

export async function discoverInteractionPlan(page: CdpInteractionPage, baseUrl: string): Promise<ScenarioPlan> {
  await page.refreshUrl().catch(() => {});
  const discovery = await page.evaluate<any>(`(() => {
    const isVisible = (el) => { if(!el) return false; const s=getComputedStyle(el); if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0) return false; const rect=el.getBoundingClientRect(); return rect.width>0 && rect.height>0 && rect.bottom>0 && rect.right>0; };
    const textOf = (el) => (el.innerText||el.textContent||el.getAttribute('aria-label')||el.getAttribute('title')||'').trim().replace(/\\s+/g,' ').slice(0,80);
    const selFor = (el) => {
      if(el.id) return '#'+CSS.escape(el.id);
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if(testId) return '[data-testid="'+testId.replace(/"/g,'')+'"]';
      const name = el.getAttribute('name'); if(name) return el.tagName.toLowerCase()+'[name="'+name.replace(/"/g,'')+'"]';
      return '';
    };
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], summary')).filter(isVisible).slice(0,20).map(el => ({text:textOf(el), selector: selFor(el), type: el.getAttribute('type')||el.tagName.toLowerCase()}));
    const links = Array.from(document.querySelectorAll('a[href]')).filter(isVisible).slice(0,30).map(el => ({text:textOf(el), href: el.getAttribute('href')||'', selector: selFor(el)}));
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible).slice(0,20).map(el => ({type:(el.getAttribute('type')||el.tagName.toLowerCase()).toLowerCase(), name:el.getAttribute('name')||'', id:el.id||'', label: (el.getAttribute('aria-label')||el.getAttribute('placeholder')||''), selector: selFor(el)}));
    const selects = Array.from(document.querySelectorAll('select')).filter(isVisible).slice(0,10).map(el => ({name:el.getAttribute('name')||'', id:el.id||'', selector: selFor(el), options: Array.from(el.options||[]).slice(0,5).map(o=>o.text||o.value)}));
    const toggles = Array.from(document.querySelectorAll('[role="switch"], input[type="checkbox"], input[type="radio"], [aria-pressed], [aria-expanded]')).filter(isVisible).slice(0,15).map(el => ({text:textOf(el), type:el.getAttribute('type')||el.getAttribute('role')||el.tagName.toLowerCase(), selector: selFor(el)}));
    const forms = Array.from(document.querySelectorAll('form')).filter(isVisible).slice(0,10).map(f => ({action:f.getAttribute('action')||'', selector: selFor(f)}));
    return { url: location.href, title: document.title, buttons, links, inputs, selects, toggles, forms, bodyLen: (document.body?.innerText||'').length, scrollHeight: document.documentElement.scrollHeight, innerHeight: window.innerHeight };
  })()`).catch(() => ({}));

  const steps: StepAction[] = [];
  let n = 1;
  const push = (step: Omit<StepAction, "step_number" | "options" | "raw_instruction"> & { options?: any; raw_instruction?: string }) => {
    steps.push({ step_number: n++, options: step.options ?? {}, raw_instruction: step.raw_instruction ?? step.name, ...step });
  };

  const pageUrl = safeStr(discovery?.url) || baseUrl;
  push({ name: "Capture initial page state", action: "screenshot", target: "", value: "" });
  // Scroll interactions
  if (Number(discovery?.scrollHeight || 0) > Number(discovery?.innerHeight || 0) + 200) {
    push({ name: "Scroll down page", action: "scroll", target: "", value: "down" });
    push({ name: "Screenshot after scroll down", action: "screenshot", target: "", value: "" });
    push({ name: "Scroll to bottom", action: "scroll", target: "", value: "bottom" });
    push({ name: "Scroll to top", action: "scroll", target: "", value: "top" });
  }

  const baseOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return ""; } })();
  const sameOriginLinks = asArray<any>(discovery?.links).filter((l) => {
    const href = safeStr(l?.href);
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;
    try { const u = new URL(href, pageUrl); return !baseOrigin || u.origin === baseOrigin; } catch { return href.startsWith("/"); }
  });
  // Click a few in-page/nav-like non-destructive buttons
  for (const b of asArray<any>(discovery?.buttons).slice(0, 5)) {
    const text = safeStr(b?.text) || safeStr(b?.selector);
    if (!text) continue;
    if (/delete|remove|pay|purchase|confirm order|subscribe now/i.test(text)) continue;
    push({ name: `Click button: ${text.slice(0, 40)}`, action: "click", target: text, value: "" });
    push({ name: "Screenshot after button click", action: "screenshot", target: "", value: "" });
  }
  // Toggle controls
  for (const t of asArray<any>(discovery?.toggles).slice(0, 5)) {
    const text = safeStr(t?.text) || safeStr(t?.selector) || safeStr(t?.type);
    if (!text) continue;
    push({ name: `Toggle control: ${text.slice(0, 40)}`, action: "click", target: text, value: "" });
  }
  // Fill forms safely (synthetic/invalid then observe validation) - do not submit destructive actions blindly
  const inputs = asArray<any>(discovery?.inputs);
  void inputs.length; // discovery available
  if (inputs.length > 0) {
    for (const inp of inputs.slice(0, 6)) {
      const type = safeStr(inp?.type);
      if (["hidden", "file", "submit", "button", "image", "checkbox", "radio"].includes(type)) continue;
      const target = safeStr(inp?.label) || safeStr(inp?.name) || safeStr(inp?.id) || safeStr(inp?.selector);
      if (!target) continue;
      const envEmail = process.env.LEMMA_TEST_EMAIL || process.env.LEMMA_LOGIN_EMAIL || process.env.TEST_EMAIL || "";
      const envPassword = process.env.LEMMA_TEST_PASSWORD || process.env.LEMMA_LOGIN_PASSWORD || process.env.TEST_PASSWORD || "";
      const envUser = process.env.LEMMA_TEST_USERNAME || process.env.LEMMA_LOGIN_USERNAME || process.env.TEST_USERNAME || "";
      const isLoginLike = /login|sign.?in|auth|email|user|password/i.test(target) || /login|sign.?in|auth/i.test(pageUrl);
      let val = type === "email" ? "test@example.invalid" : type === "password" ? "InvalidPass!123" : type === "number" ? "1" : "test value";
      if (isLoginLike) {
        if (type === "password" && envPassword) val = envPassword;
        else if (type === "email" && envEmail) val = envEmail;
        else if ((type === "text" || type === "") && envEmail && /email/i.test(target)) val = envEmail;
        else if ((type === "text" || type === "") && envUser && /user|login/i.test(target)) val = envUser;
      }
      push({ name: `Fill input: ${target.slice(0, 40)}`, action: "fill", target, value: val });
    }
    // try submit if a submit button exists (safe validation check)
    const submitBtn = asArray<any>(discovery?.buttons).find((b) => /submit|sign in|log in|login|continue|send/i.test(safeStr(b?.text)) || safeStr(b?.type) === "submit");
    if (submitBtn) {
      const text = safeStr(submitBtn?.text) || "submit";
      push({ name: `Submit form/button: ${text.slice(0, 40)} (validation check)`, action: "click", target: text, value: "" });
      push({ name: "Screenshot after submit attempt", action: "screenshot", target: "", value: "" });
      push({ name: "Assert page remains stable after submit attempt", action: "assert_no_errors", target: "", value: "" });
    }
  }
  // Selects
  for (const s of asArray<any>(discovery?.selects).slice(0, 3)) {
    const target = safeStr(s?.name) || safeStr(s?.id) || safeStr(s?.selector);
    const opt = safeStr(asArray<any>(s?.options)[1] || asArray<any>(s?.options)[0]);
    if (target && opt) push({ name: `Select option: ${target.slice(0, 30)}`, action: "select", target, value: opt });
  }
  // Same-origin link clicks (limited) for navigation flow coverage - use direct navigation for reliability
  let navClicks = 0;
  for (const l of sameOriginLinks.slice(0, 12)) {
    if (navClicks >= 5) break;
    const href = safeStr(l?.href);
    const text = safeStr(l?.text);
    if (!href) continue;
    let abs = "";
    try {
      const u = new URL(href, pageUrl);
      if (u.href === pageUrl || u.origin !== baseOrigin) continue;
      abs = u.href;
    } catch { continue; }
    const label = text || abs;
    push({ name: `Navigate via link: ${label.slice(0, 40)}`, action: "goto", target: abs, value: "" });
    push({ name: "Scroll down navigated page", action: "scroll", target: "", value: "down" });
    push({ name: "Screenshot after navigation", action: "screenshot", target: "", value: "" });
    push({ name: "Return to base page", action: "goto", target: pageUrl, value: "" });
    navClicks++;
  }
  push({ name: "Final screenshot", action: "screenshot", target: "", value: "" });

  return {
    title: `Auto interaction regression: ${safeStr(discovery?.title) || pageUrl}`,
    steps,
    source: "auto-discovered",
    model: "cdp-auto",
    target_url: pageUrl || baseUrl,
  };
}

export async function runAutomaticInteractions(opts: {
  call: CdpCall;
  sessionId?: string;
  baseUrl: string;
  evidence?: BrowserScenarioEvidenceStoreLike;
  timeoutMs?: number;
  label?: string;
}): Promise<ScenarioExecutionResult & { plan: ScenarioPlan }> {
  const page = new CdpInteractionPage({
    call: opts.call,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  });
  await page.refreshUrl().catch(() => {});
  const plan = await discoverInteractionPlan(page, opts.baseUrl);
  const exec = await executeScenarioPlan(page, plan, opts.evidence, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  });
  return { ...exec, plan };
}
