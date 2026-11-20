import { Buffer } from "node:buffer";

import {
  type ScenarioExecutionResult,
  type ScenarioPlan,
  type SourceFeature,
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

export interface DiscoverInteractionPlanOptions {
  /** True when the caller is already iterating across multiple crawled/source routes. */
  multiTargetRun?: boolean;
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
    // Dispatched natively inside _fill / _select / adjustSlider.
  }

  async selectOption(value: unknown): Promise<void> {
    await this.scrollIntoViewIfNeeded().catch(() => {});
    const v =
      typeof value === "string"
        ? value
        : value && typeof value === "object"
          ? safeStr((value as any).label || (value as any).value)
          : String(value ?? "");
    const ok = await this.page._select(this.kind, this.query, v);
    if (!ok) throw new Error(`Select failed for ${this.kind}:${this.query}`);
  }
}

export class CdpInteractionPage implements BrowserScenarioPageLike {
  private readonly call: CdpCall;
  private readonly sessionId: string | undefined;
  private _lastUrl = "";

  constructor(opts: CdpInteractionPageOptions) {
    this.call = opts.call;
    this.sessionId = opts.sessionId;
  }

  async goto(url: string): Promise<void> {
    await this.call("Page.navigate", { url }, this.sessionId);
    await this.waitForTimeout(900);
    await this.refreshUrl();
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  url(): string {
    return this._lastUrl;
  }

  async refreshUrl(): Promise<string> {
    try {
      const res = await this.evaluate("location.href");
      this._lastUrl = safeStr(res);
    } catch {}
    return this._lastUrl;
  }

  [key: string]: unknown;

  async innerText(selector: string): Promise<string> {
    const expr =
      selector === "body"
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
      const shot = await this.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, this.sessionId);
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
    return res?.result?.value as T;
  }

  /**
   * Scroll progressively down and back to top so IntersectionObserver /
   * framer-motion `whileInView` sections transition from opacity:0 to visible
   * before DOM discovery runs.
   */
  async scrollWarmup(): Promise<void> {
    try {
      const dims = await this.evaluate<{ sh: number; ih: number }>(
        `({ sh: document.documentElement.scrollHeight || 0, ih: window.innerHeight || 0 })`,
      );
      if (!dims || dims.sh <= dims.ih + 120) return;
      const stops = [0.35, 0.7, 1.0];
      for (const ratio of stops) {
        const y = Math.round(dims.sh * ratio);
        await this.evaluate(`window.scrollTo({ top: ${y}, behavior: "instant" }); true`).catch(() => {});
        await this.waitForTimeout(180);
      }
      await this.evaluate(`window.scrollTo({ top: 0, behavior: "instant" }); true`).catch(() => {});
      await this.waitForTimeout(220);
    } catch {
      // best-effort warmup
    }
  }

  async _find(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "find");
    try {
      return Boolean(await this.evaluate(expr));
    } catch {
      return false;
    }
  }

  async _scrollIntoView(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "scroll");
    try {
      return Boolean(await this.evaluate(expr));
    } catch {
      return false;
    }
  }

  async _click(kind: string, query: string, role?: string): Promise<boolean> {
    const expr = buildFindExpr(kind, query, role, "click");
    try {
      const ok = Boolean(await this.evaluate(expr));
      await this.waitForTimeout(350);
      await this.refreshUrl();
      return ok;
    } catch {
      return false;
    }
  }

  async _fill(kind: string, query: string, role: string | undefined, value: string): Promise<boolean> {
    const expr = buildFillExpr(kind, query, role, value);
    try {
      const ok = Boolean(await this.evaluate(expr));
      await this.waitForTimeout(220);
      return ok;
    } catch {
      return false;
    }
  }

  async _select(kind: string, query: string, value: string): Promise<boolean> {
    const expr = buildSelectExpr(kind, query, value);
    try {
      const res = await this.evaluate<string | boolean>(expr);
      if (res === "combobox-opened") {
        await this.waitForTimeout(280);
        const picked = await this.evaluate<boolean>(buildPickComboboxOptionExpr(value));
        await this.waitForTimeout(220);
        return Boolean(picked);
      }
      await this.waitForTimeout(220);
      return Boolean(res);
    } catch {
      return false;
    }
  }

  async adjustSlider(target: string, value: string): Promise<boolean> {
    const expr = buildSliderExpr(target, value);
    try {
      const mode = await this.evaluate<string | boolean>(expr);
      if (!mode) return false;
      if (mode === "aria-slider") {
        for (let i = 0; i < 5; i++) {
          await this.call(
            "Input.dispatchKeyEvent",
            { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
            this.sessionId,
          ).catch(() => {});
          await this.call(
            "Input.dispatchKeyEvent",
            { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
            this.sessionId,
          ).catch(() => {});
        }
      }
      await this.waitForTimeout(280);
      return true;
    } catch {
      return false;
    }
  }

  async scrollPage(direction: "top" | "bottom" | "down" | "up", amount = 800): Promise<void> {
    const expr =
      direction === "top"
        ? "window.scrollTo(0,0); true"
        : direction === "bottom"
          ? "window.scrollTo(0, document.body.scrollHeight); true"
          : direction === "down"
            ? `window.scrollBy(0, ${amount}); true`
            : `window.scrollBy(0, ${-amount}); true`;
    await this.evaluate(expr).catch(() => {});
    await this.waitForTimeout(250);
  }
}

function jsStr(s: string): string {
  return JSON.stringify(s ?? "");
}

export function buildFindExpr(kind: string, query: string, role: string | undefined, mode: "find" | "scroll" | "click"): string {
  const q = jsStr(query);
  const r = jsStr(role || "");
  const action =
    mode === "find"
      ? "return true;"
      : mode === "scroll"
        ? "el.scrollIntoView({block:'center',inline:'center'}); return true;"
        : "el.focus && el.focus(); el.click(); return true;";
  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const pick = (els) => {
      const arr = Array.from(els || []);
      return arr.find(isVisible) || null;
    };
    let el = null;
    const kind = ${jsStr(kind)}, q = ${q}, role = ${r};
    const qStr = String(q || '');
    const t = norm(qStr);
    if (kind === 'css') {
      try {
        el = qStr.startsWith('text=')
          ? pick(Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="switch"],summary,label,*')).filter((n) => norm(n.innerText || n.textContent).includes(norm(qStr.slice(5)))))
          : pick(document.querySelectorAll(qStr));
      } catch (e) { el = null; }
    } else if (kind === 'text') {
      const candidates = Array.from(document.querySelectorAll('button,a,[role="button"],[role="tab"],[role="switch"],[role="checkbox"],summary,label,input[type="submit"],input[type="button"]'));
      el = pick(candidates.filter((n) => norm(n.innerText || n.textContent || n.value || n.getAttribute('aria-label')) === t))
        || pick(candidates.filter((n) => norm(n.innerText || n.textContent || n.value || n.getAttribute('aria-label')).includes(t)));
    } else if (kind === 'label') {
      const labels = Array.from(document.querySelectorAll('label')).filter((l) => norm(l.innerText || l.textContent).includes(t));
      for (const l of labels) {
        if (l.control && isVisible(l.control)) { el = l.control; break; }
        const id = l.getAttribute('for');
        if (id) {
          const byId = document.getElementById(id);
          if (byId && isVisible(byId)) { el = byId; break; }
        }
      }
      if (!el) {
        el = pick(Array.from(document.querySelectorAll('input,textarea,select,button[role="switch"],[role="switch"],[role="checkbox"]')).filter((n) =>
          norm((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('name') || '') + ' ' + (n.getAttribute('placeholder') || '')).includes(t)
        ));
      }
    } else if (kind === 'placeholder') {
      el = pick(Array.from(document.querySelectorAll('input,textarea')).filter((n) => norm(n.getAttribute('placeholder')).includes(t)));
    } else if (kind === 'role') {
      const sel = role === 'button'
        ? 'button,[role="button"],a,input[type="button"],input[type="submit"]'
        : role === 'tab'
          ? '[role="tab"]'
          : role === 'switch'
            ? 'button[role="switch"],[role="switch"],input[type="checkbox"]'
            : role === 'checkbox'
              ? '[role="checkbox"],input[type="checkbox"]'
              : '[role="' + role + '"]';
      const nodes = Array.from(document.querySelectorAll(sel));
      el = !t
        ? pick(nodes)
        : pick(nodes.filter((n) => norm(n.innerText || n.textContent || n.getAttribute('aria-label') || n.value) === t))
          || pick(nodes.filter((n) => norm(n.innerText || n.textContent || n.getAttribute('aria-label') || n.value).includes(t)));
    }
    if (!el) return false;
    ${action}
  })()`;
}

export function buildFillExpr(kind: string, query: string, _role: string | undefined, value: string): string {
  const q = jsStr(query);
  const v = jsStr(value);
  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const norm = (x) => String(x || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const pick = (els) => Array.from(els || []).find(isVisible) || null;
    let el = null;
    const kind = ${jsStr(kind)}, q = ${q}, val = ${v};
    const t = norm(q);
    if (kind === 'css') {
      try { el = pick(document.querySelectorAll(q)); } catch (e) { el = null; }
    } else if (kind === 'label') {
      const labels = Array.from(document.querySelectorAll('label')).filter((l) => norm(l.innerText || l.textContent).includes(t));
      for (const l of labels) {
        if (l.control && isVisible(l.control)) { el = l.control; break; }
        const id = l.getAttribute('for');
        if (id) {
          const byId = document.getElementById(id);
          if (byId && isVisible(byId)) { el = byId; break; }
        }
      }
      if (!el) {
        el = pick(Array.from(document.querySelectorAll('input,textarea,select')).filter((n) =>
          norm((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('name') || '') + ' ' + (n.getAttribute('placeholder') || '') + ' ' + (n.id || '')).includes(t)
        ));
      }
    } else if (kind === 'placeholder') {
      el = pick(Array.from(document.querySelectorAll('input,textarea')).filter((n) => norm(n.getAttribute('placeholder')).includes(t)));
    } else if (kind === 'text') {
      el = pick(Array.from(document.querySelectorAll('input,textarea')).filter((n) =>
        norm((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('name') || '') + ' ' + (n.getAttribute('placeholder') || '') + ' ' + (n.id || '')).includes(t)
      ));
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.focus && el.focus();
    const proto = el.tagName === 'TEXTAREA'
      ? (window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype)
      : (window.HTMLInputElement && window.HTMLInputElement.prototype);
    const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
    if (desc && typeof desc.set === 'function') {
      desc.set.call(el, val);
    } else if ('value' in el) {
      el.value = val;
    } else {
      el.textContent = val;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function buildSelectExpr(_kind: string, query: string, value: string): string {
  const q = jsStr(query);
  const v = jsStr(value);
  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const norm = (x) => String(x || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const pick = (els) => Array.from(els || []).find(isVisible) || null;
    let el = null;
    const q = ${q}, val = ${v};
    try {
      const direct = pick(document.querySelectorAll(q));
      // Text inputs with role=combobox (jQuery autocomplete, etc.) are filled,
      // not selected. Treat them as "not a select target".
      if (direct && direct.tagName !== 'INPUT') el = direct;
    } catch (e) {}
    if (!el) {
      const t = norm(q);
      el = pick(Array.from(document.querySelectorAll('select,button[role="combobox"],[role="combobox"]')).filter((n) =>
        n.tagName !== 'INPUT' &&
        norm((n.getAttribute('aria-label') || '') + ' ' + (n.getAttribute('name') || '') + ' ' + (n.id || '')).includes(t)
      ));
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.tagName !== 'SELECT') {
      el.click();
      return 'combobox-opened';
    }
    const opts = Array.from(el.options || []).filter((o) => !o.disabled);
    const match =
      opts.find((o) => o.value === val || norm(o.text) === norm(val) || (val && norm(o.text).includes(norm(val))))
      || opts.find((o) => o.value !== '')
      || opts[0];
    if (!match) return false;
    const desc = window.HTMLSelectElement ? Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value') : null;
    if (desc && typeof desc.set === 'function') desc.set.call(el, match.value);
    else el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function buildPickComboboxOptionExpr(value: string): string {
  const v = jsStr(value);
  return `(() => {
    const norm = (x) => String(x || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    const val = norm(${v});
    const options = Array.from(document.querySelectorAll('[role="option"], [data-radix-collection-item]')).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    if (options.length === 0) return false;
    const chosen = (val && options.find((o) => norm(o.innerText || o.textContent).includes(val))) || options[1] || options[0];
    if (!chosen) return false;
    chosen.click();
    return true;
  })()`;
}

function buildSliderExpr(target: string, value: string): string {
  const q = jsStr(target);
  const v = jsStr(value);
  return `(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const pick = (els) => Array.from(els || []).find(isVisible) || null;
    const q = ${q}, val = ${v};
    let el = null;
    if (q) {
      try { el = pick(document.querySelectorAll(q)); } catch (e) {}
    }
    if (!el) el = pick(document.querySelectorAll('[role="slider"], input[type="range"]'));
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.tagName === 'INPUT') {
      const min = Number(el.min || 0);
      const max = Number(el.max || 100);
      const next = val && !Number.isNaN(Number(val)) ? String(val) : String(Math.round(min + (max - min) * 0.65));
      const desc = window.HTMLInputElement ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') : null;
      if (desc && typeof desc.set === 'function') desc.set.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'range-input';
    }
    el.focus && el.focus();
    for (let i = 0; i < 5; i++) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39, bubbles: true }));
    }
    return 'aria-slider';
  })()`;
}

function syntheticValueForField(label: string, typeHint = "", placeholder = ""): string {
  // Never read real credentials from the environment. Interaction plans and
  // their synthetic values are persisted as evidence, so only clearly-fake
  // values may be used. Auth-gated flows are reported as coverage gaps, not
  // auto-filled with live secrets.
  const combined = `${label} ${placeholder} ${typeHint}`.toLowerCase();
  const t = typeHint.toLowerCase();

  if (t === "password" || /password|passcode|secret/.test(combined)) return "InvalidPass!123";
  if (t === "email" || /\bemail\b/.test(combined)) return "qa-check@example.invalid";
  if (t === "url" || /\b(?:url|website|portfolio|linkedin|github|resume|http)\b/.test(combined)) return "https://example.invalid/qa-check";
  if (t === "tel" || /\b(?:phone|mobile|tel)\b/.test(combined)) return "+15550109999";
  if (t === "number" || /\b(?:count|qty|quantity|amount|seats|developers)\b/.test(combined)) return "12";
  if (t === "date") return "2026-06-15";
  if (/\b(?:search|query|filter|find)\b/.test(combined)) return "architecture";
  if (/\bfirst.?name\b/.test(combined)) return "Alex";
  if (/\b(?:last.?name|surname)\b/.test(combined)) return "Rivera";
  if (/\b(?:username|login)\b/.test(combined)) return "qa-check-user";
  if (/\b(?:company|organization|org|workspace)\b/.test(combined)) return "Lemma QA";
  if (/\b(?:role|title|position)\b/.test(combined)) return "QA Engineer";
  if (/\bname\b/.test(combined)) return "Alex Rivera";
  if (t === "textarea" || /\b(?:message|note|cover|description|comment|details|summary)\b/.test(combined)) {
    return "Automated browser regression check verifying interactive form state.";
  }
  return "Lemma QA check";
}

function normalizeMatchText(s: string): string {
  return s.replace(/\*/g, "").replace(/\s*\(optional\)\s*/gi, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

export async function discoverInteractionPlan(
  page: CdpInteractionPage,
  baseUrl: string,
  features: SourceFeature[] = [],
  dedupe: Set<string> = new Set<string>(),
  planOptions: DiscoverInteractionPlanOptions = {},
): Promise<ScenarioPlan> {
  await page.refreshUrl().catch(() => {});
  if (typeof (page as any).scrollWarmup === "function") {
    await page.scrollWarmup().catch(() => {});
  }

  const discovery = await page
    .evaluate<any>(`(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const inGlobalChrome = (el) => Boolean(el && el.closest && el.closest('header, nav, footer, [role="navigation"]'));
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const labelFor = (el) => {
      if (el.labels && el.labels.length > 0) {
        const lt = textOf(el.labels[0]);
        if (lt) return lt;
      }
      if (el.id) {
        const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
        if (lbl) {
          const lt = textOf(lbl);
          if (lt) return lt;
        }
      }
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '';
    };
    const siblingContext = (el) => {
      const parent = el && el.parentElement;
      if (!parent) return '';
      return (parent.innerText || parent.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    };
    const selFor = (el) => {
      if (el.id) return '#' + CSS.escape(el.id);
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
      if (testId) return '[data-testid="' + testId.replace(/"/g, '') + '"]';
      const name = el.getAttribute('name');
      if (name) return el.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '') + '"]';
      const ph = el.getAttribute('placeholder');
      if (ph && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        return el.tagName.toLowerCase() + '[placeholder="' + ph.replace(/"/g, '') + '"]';
      }
      const role = el.getAttribute('role');
      const aria = el.getAttribute('aria-label');
      if (role && aria) return '[role="' + role + '"][aria-label="' + aria.replace(/"/g, '') + '"]';
      return '';
    };
    let refCounter = 1;
    const uniqueSel = (el, fallbackSel) => {
      const direct = selFor(el);
      if (direct) return direct;
      if (fallbackSel) {
        try {
          const all = Array.from(document.querySelectorAll(fallbackSel)).filter(isVisible);
          if (all.length === 1 && all[0] === el) return fallbackSel;
        } catch (e) {}
      }
      const t = textOf(el);
      if (t) return 'text=' + t;
      const refId = 'lemma-' + (refCounter++);
      try { el.setAttribute('data-lemma-ref', refId); return '[data-lemma-ref="' + refId + '"]'; } catch (e) {}
      return fallbackSel || '';
    };

    const toggleEls = Array.from(document.querySelectorAll('button[role="switch"], [role="switch"], [role="checkbox"], input[type="checkbox"], input[type="radio"], [aria-pressed]')).filter(isVisible);
    const sliderEls = Array.from(document.querySelectorAll('[role="slider"], input[type="range"]')).filter(isVisible);
    const tabEls = Array.from(document.querySelectorAll('[role="tab"]')).filter(isVisible);
    const accordionEls = Array.from(document.querySelectorAll('button[aria-expanded], [data-radix-collection-item][aria-expanded], details > summary'))
      .filter((el) => isVisible(el) && !inGlobalChrome(el) && el.getAttribute('role') !== 'switch' && el.getAttribute('role') !== 'combobox');
    const selectEls = Array.from(document.querySelectorAll('select, button[role="combobox"], [role="combobox"]')).filter(isVisible);
    const specialSet = new Set([...toggleEls, ...sliderEls, ...tabEls, ...accordionEls, ...selectEls]);

    const toggles = toggleEls.slice(0, 12).map((el, i) => ({
      text: textOf(el) || labelFor(el) || siblingContext(el) || 'Switch toggle',
      selector: uniqueSel(el, el.getAttribute('role') === 'switch' ? '[role="switch"]' : '[role="checkbox"], input[type="checkbox"]', i),
      type: el.getAttribute('role') || el.getAttribute('type') || el.tagName.toLowerCase(),
      inChrome: inGlobalChrome(el),
    }));
    const sliders = sliderEls.slice(0, 6).map((el, i) => ({
      text: labelFor(el) || siblingContext(el) || 'Range slider',
      selector: uniqueSel(el, '[role="slider"], input[type="range"]', i),
    }));
    const tabs = tabEls.slice(0, 10).map((el, i) => ({
      text: textOf(el),
      selector: uniqueSel(el, '[role="tab"]', i),
    }));
    const accordions = accordionEls.slice(0, 10).map((el, i) => ({
      text: textOf(el),
      selector: uniqueSel(el, 'button[aria-expanded], details > summary', i),
    }));
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'))
      .filter((el) => isVisible(el) && !specialSet.has(el))
      .slice(0, 30)
      .map((el) => ({
        text: textOf(el),
        selector: selFor(el),
        type: (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase(),
        inChrome: inGlobalChrome(el),
        isSubmit: (el.getAttribute('type') || '').toLowerCase() === 'submit' || Boolean(el.closest('form') && /submit|send|apply|request|join|continue|save/i.test(textOf(el))),
      }));
    const links = Array.from(document.querySelectorAll('a[href]')).filter(isVisible).slice(0, 30).map((el) => {
      const href = el.getAttribute('href') || '';
      const escapedHref = href.replace(/"/g, '\\\\"');
      return {
        text: textOf(el),
        href,
        selector: selFor(el) || (href ? 'a[href="' + escapedHref + '"]' : ''),
        inChrome: inGlobalChrome(el),
      };
    });
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible).slice(0, 20).map((el) => ({
      type: (el.tagName === 'TEXTAREA' ? 'textarea' : (el.getAttribute('type') || 'text')).toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: labelFor(el),
      placeholder: el.getAttribute('placeholder') || '',
      required: Boolean(el.required || el.hasAttribute('required')),
      selector: selFor(el),
    }));
    const selects = selectEls.filter((el) => el.tagName !== 'INPUT').slice(0, 10).map((el, i) => ({
      tag: el.tagName.toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      label: labelFor(el),
      selector: uniqueSel(el, el.tagName === 'SELECT' ? 'select' : '[role="combobox"]', i),
      options: el.tagName === 'SELECT'
        ? Array.from(el.options || []).filter((o) => !o.disabled && o.value !== '').slice(0, 6).map((o) => (o.text || o.value || '').trim())
        : [],
    }));
    const forms = Array.from(document.querySelectorAll('form')).filter(isVisible).slice(0, 10).map((f) => ({
      action: f.getAttribute('action') || '',
      selector: selFor(f),
    }));
    return {
      liveDom: true,
      url: location.href,
      title: document.title,
      buttons,
      links,
      inputs,
      selects,
      toggles,
      sliders,
      tabs,
      accordions,
      forms,
      bodyLen: (document.body?.innerText || '').length,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  })()`)
    .catch(() => ({}));

  const steps: StepAction[] = [];
  let n = 1;
  const push = (
    step: Omit<StepAction, "step_number" | "options" | "raw_instruction"> & { options?: Record<string, unknown>; raw_instruction?: string },
  ) => {
    // Auto-discovered steps are exploratory. If a control disappears after an
    // earlier interaction, that is a coverage gap rather than a product failure.
    steps.push({ step_number: n++, raw_instruction: step.raw_instruction ?? step.name, ...step, options: { soft: true, ...(step.options ?? {}) } });
  };

  const pageUrl = safeStr(discovery?.url) || baseUrl;
  const routePath = (() => {
    try {
      return new URL(pageUrl).pathname || "/";
    } catch {
      return "/";
    }
  })();
  const isLiveDom = discovery?.liveDom === true;
  // Do not auto-click destructive or real-transaction CTAs. Keep this narrow:
  // a pricing toggle labelled "Pay monthly / Pay annually" must still run.
  const destructive = /\b(?:delete|remove|destroy|pay now|make payment|complete purchase|purchase now|confirm order|checkout|subscribe now|cancel account|close account|log\s*out|sign\s*out)\b/i;
  const externalOauth = /\b(?:continue with github|sign up with github|continue with google|sign up with google|continue with sso|sign in with sso)\b/i;

  const pushUnique = (
    step: Omit<StepAction, "step_number" | "options" | "raw_instruction"> & { options?: Record<string, unknown>; raw_instruction?: string },
    scope = "",
  ): boolean => {
    const key = `${step.action}|${step.target}|${step.value}|${scope || pageUrl}`;
    if (dedupe.has(key)) return false;
    dedupe.add(key);
    push(step);
    return true;
  };

  push({ name: `Capture initial state (${routePath})`, action: "screenshot", target: "", value: "" });

  // 1. Scroll coverage across the page
  if (Number(discovery?.scrollHeight || 0) > Number(discovery?.innerHeight || 0) + 200) {
    push({ name: `Scroll down page (${routePath})`, action: "scroll", target: "", value: "down" });
    push({ name: `Screenshot after scroll (${routePath})`, action: "screenshot", target: "", value: "" });
    push({ name: `Scroll to bottom (${routePath})`, action: "scroll", target: "", value: "bottom" });
    push({ name: `Scroll back to top (${routePath})`, action: "scroll", target: "", value: "top" });
  }

  // When running standalone on a single URL (not part of a multi-route crawl),
  // probe concrete public source routes and return to `pageUrl` before exercising `pageUrl`'s controls.
  if (!planOptions.multiTargetRun) {
    const sourceRoutes = features
      .filter((f) => f.kind === "route" && !f.auth_required && !/^\/api\//i.test(f.label) && !/[:*${]/.test(f.label))
      .slice(0, 6);
    let navigatedAway = false;
    for (const f of sourceRoutes) {
      let dest = "";
      try {
        dest = new URL(f.label, baseUrl).href;
      } catch {
        continue;
      }
      if (dest === pageUrl) continue;
      if (
        pushUnique(
          { name: `Source route: ${f.label} (${f.source.path}:${f.source.line})`, action: "goto", target: dest, value: "" },
          `route:${dest}`,
        )
      ) {
        push({ name: `Screenshot after source route: ${f.label}`, action: "screenshot", target: "", value: "" });
        navigatedAway = true;
      }
    }
    if (navigatedAway) {
      push({ name: `Return to ${routePath} for feature interactions`, action: "goto", target: pageUrl, value: "" });
    }
  }

  // Filter source features relevant to `routePath`: explicit route match OR unscoped/shared components.
  const routeApplies = (f: SourceFeature): boolean => {
    const normalized = routePath.replace(/\/+$/, "") || "/";
    const routesMatch = Array.isArray(f.routes) && f.routes.some((r) => (r.replace(/\/+$/, "") || "/") === normalized);
    // For links, `route_hint` is the destination; only `routes` identifies the
    // source page that owns the control.
    if (f.kind === "link") return routesMatch;
    if (f.route_hint && (f.route_hint.replace(/\/+$/, "") || "/") === normalized) return true;
    if (routesMatch) return true;
    return !f.route_hint && (!f.routes || f.routes.length === 0);
  };
  const candidateFeatures = features.filter(routeApplies);
  const byKind = (kind: SourceFeature["kind"]) => candidateFeatures.filter((f) => f.kind === kind);
  // A source feature may only pair with a live control through an exact selector
  // or exact accessible label. Loose substring/positional matches caused steps
  // from one snapshot page to be executed against another page's control.
  const matchesFeature = (f: SourceFeature, selector: string, label: string): boolean =>
    Boolean(f.selector_hint && selector && f.selector_hint === selector) ||
    Boolean(f.label && label && normalizeMatchText(f.label) === normalizeMatchText(label));

  // Track which live DOM items were already paired with a source feature so we never double-click/double-fill.
  const usedToggles = new Set<number>();
  const usedSliders = new Set<number>();
  const usedTabs = new Set<number>();
  const usedAccordions = new Set<number>();
  const usedInputs = new Set<number>();
  const usedSelects = new Set<number>();
  const usedButtons = new Set<number>();

  const liveToggles = asArray<any>(discovery?.toggles);
  const liveSliders = asArray<any>(discovery?.sliders);
  const liveTabs = asArray<any>(discovery?.tabs);
  const liveAccordions = asArray<any>(discovery?.accordions);
  const liveInputs = asArray<any>(discovery?.inputs).filter(
    (inp) => !["hidden", "file", "submit", "button", "image", "checkbox", "radio", "range"].includes(safeStr(inp?.type)),
  );
  // jQuery-style autocomplete widgets expose role=combobox on a text input.
  // Those are filled, never selected; treating them as selects caused false
  // "select failed" steps in the the-internet run.
  const liveSelects = asArray<any>(discovery?.selects).filter(
    (ls) => safeStr(ls?.tag).toLowerCase() !== "input",
  );
  const liveButtons = asArray<any>(discovery?.buttons);

  // 2. Toggles / Switches (source-backed + remaining visible toggles on page)
  const srcToggles = byKind("toggle");
  if (!isLiveDom) {
    for (const f of srcToggles.slice(0, 6)) {
      if (destructive.test(f.label)) continue;
      pushUnique(
        { name: `Source toggle: ${f.label} (${f.source.path}:${f.source.line})`, action: "toggle", target: f.selector_hint || f.label, value: "" },
        `feature:${f.id}`,
      );
    }
  } else {
    for (let i = 0; i < liveToggles.length && i < 8; i++) {
      const lt = liveToggles[i];
      const text = safeStr(lt?.text);
      const sel = safeStr(lt?.selector) || text;
      if (!sel || destructive.test(text)) continue;
      const matched = srcToggles.find((f) => !dedupe.has(`feature:${f.id}`) && matchesFeature(f, sel, text));
      const scope = matched ? `feature:${matched.id}` : lt?.inChrome ? `global-toggle:${normalizeMatchText(text)}` : `${routePath}|toggle:${sel}`;
      const stepName = matched
        ? `Source toggle: ${matched.label} (${matched.source.path}:${matched.source.line})`
        : `Toggle switch/checkbox: ${text.slice(0, 48)}`;
      if (pushUnique({ name: stepName, action: "toggle", target: sel, value: "" }, scope)) {
        usedToggles.add(i);
        push({ name: `Screenshot after toggle: ${(matched?.label || text).slice(0, 40)}`, action: "screenshot", target: "", value: "" });
        // Toggle back to verify bidirectional state transition without errors
        push({ name: `Restore toggle state: ${(matched?.label || text).slice(0, 40)}`, action: "toggle", target: sel, value: "" });
      }
    }
  }

  // 3. Sliders / Range calculators
  const srcSliders = byKind("slider");
  if (!isLiveDom) {
    for (const f of srcSliders.slice(0, 4)) {
      pushUnique(
        { name: `Source slider: ${f.label} (${f.source.path}:${f.source.line})`, action: "slide", target: f.selector_hint || f.label, value: "25" },
        `feature:${f.id}`,
      );
    }
  } else {
    for (let i = 0; i < liveSliders.length && i < 4; i++) {
      const ls = liveSliders[i];
      const sel = safeStr(ls?.selector) || '[role="slider"], input[type="range"]';
      const text = safeStr(ls?.text) || "Slider";
      const matched = srcSliders.find((f) => !dedupe.has(`feature:${f.id}`));
      const scope = matched ? `feature:${matched.id}` : `${routePath}|slider:${sel}`;
      const stepName = matched
        ? `Source slider: ${matched.label} (${matched.source.path}:${matched.source.line})`
        : `Adjust slider: ${text.slice(0, 48)}`;
      if (pushUnique({ name: stepName, action: "slide", target: sel, value: "30" }, scope)) {
        usedSliders.add(i);
        push({ name: `Screenshot after slider adjustment (${(matched?.label || text).slice(0, 36)})`, action: "screenshot", target: "", value: "" });
      }
    }
  }

  // 4. Tabs
  const srcTabs = byKind("tab");
  if (!isLiveDom) {
    for (const f of srcTabs.slice(0, 6)) {
      pushUnique(
        { name: `Source tab: ${f.label} (${f.source.path}:${f.source.line})`, action: "click", target: f.selector_hint || f.label, value: "" },
        `feature:${f.id}`,
      );
    }
  } else {
    let clickedTab = false;
    for (let i = 0; i < liveTabs.length && i < 6; i++) {
      const tab = liveTabs[i];
      const text = safeStr(tab?.text);
      const sel = safeStr(tab?.selector) || text;
      if (!sel) continue;
      const matched = srcTabs.find((f) => !dedupe.has(`feature:${f.id}`) && matchesFeature(f, sel, text));
      const scope = matched ? `feature:${matched.id}` : `${routePath}|tab:${text || sel}`;
      const stepName = matched
        ? `Source tab: ${matched.label} (${matched.source.path}:${matched.source.line})`
        : `Switch tab: ${(text || sel).slice(0, 48)}`;
      if (pushUnique({ name: stepName, action: "click", target: text || sel, value: "", options: { stayOnPageUrl: pageUrl } }, scope)) {
        usedTabs.add(i);
        clickedTab = true;
      }
    }
    if (clickedTab) {
      push({ name: `Screenshot after tab switching (${routePath})`, action: "screenshot", target: "", value: "" });
    }
  }

  // 5. Accordions / Collapsible sections (FAQs, job roles, details)
  const srcAccordions = byKind("accordion");
  if (!isLiveDom) {
    for (const f of srcAccordions.slice(0, 5)) {
      pushUnique(
        { name: `Source accordion: ${f.label} (${f.source.path}:${f.source.line})`, action: "click", target: f.selector_hint || f.label, value: "" },
        `feature:${f.id}`,
      );
    }
  } else {
    let expandedAny = false;
    for (let i = 0; i < liveAccordions.length && i < 5; i++) {
      const acc = liveAccordions[i];
      const text = safeStr(acc?.text);
      const sel = safeStr(acc?.selector) || text;
      if (!text && !sel) continue;
      const templateMatch = srcAccordions.find(
        (f) => !dedupe.has(`feature:${f.id}`) && f.label !== "Accordion section" && matchesFeature(f, sel, text),
      );
      const scope = templateMatch ? `feature:${templateMatch.id}` : `${routePath}|accordion:${normalizeMatchText(text || sel)}`;
      const stepName = templateMatch
        ? `Source accordion: ${(text || templateMatch.label).slice(0, 48)} (${templateMatch.source.path}:${templateMatch.source.line})`
        : `Expand accordion: ${(text || sel).slice(0, 48)}`;
      if (pushUnique({ name: stepName, action: "click", target: text || sel, value: "", options: { stayOnPageUrl: pageUrl } }, scope)) {
        if (templateMatch) dedupe.add(`feature:${templateMatch.id}`);
        usedAccordions.add(i);
        expandedAny = true;
      }
    }
    if (expandedAny) {
      push({ name: `Screenshot with expanded accordions (${routePath})`, action: "screenshot", target: "", value: "" });
    }
  }

  // 6. Forms: safe empty-required validation check FIRST (never submits external spam), then fill all inputs + selects!
  const srcInputs = byKind("input");
  const srcSelects = byKind("select");

  if (!isLiveDom) {
    for (const f of srcInputs.slice(0, 8)) {
      const val = syntheticValueForField(f.label, f.input_type ?? "", f.placeholder ?? "");
      pushUnique(
        { name: `Source input: ${f.label} (${f.source.path}:${f.source.line})`, action: "fill", target: f.selector_hint || f.label, value: val },
        `feature:${f.id}`,
      );
    }
    for (const f of srcSelects.slice(0, 5)) {
      if (!f.option_hint) continue;
      pushUnique(
        { name: `Source select: ${f.label} (${f.source.path}:${f.source.line})`, action: "select", target: f.selector_hint || f.label, value: f.option_hint },
        `feature:${f.id}`,
      );
    }
  } else {
    // Check if there is a form with a required field and a submit button on this page:
    // clicking submit BEFORE filling the required field exercises client-side validation safely without firing external webhooks.
    const hasRequiredInput = liveInputs.some((inp) => inp?.required === true);
    const submitBtn = liveButtons.find((b) => b?.isSubmit && !destructive.test(safeStr(b?.text)) && !externalOauth.test(safeStr(b?.text)));
    if (hasRequiredInput && submitBtn) {
      const btnTarget = safeStr(submitBtn.selector) || safeStr(submitBtn.text);
      if (btnTarget) {
        pushUnique(
          {
            name: `Validate required form guard: ${safeStr(submitBtn.text || "Submit").slice(0, 40)} (${routePath})`,
            action: "click",
            target: btnTarget,
            value: "",
            options: { stayOnPageUrl: pageUrl },
          },
          `${routePath}|empty-validation:${btnTarget}`,
        );
      }
    }

    // Selects / Comboboxes
    for (let i = 0; i < liveSelects.length && i < 6; i++) {
      const ls = liveSelects[i];
      const sel = safeStr(ls?.selector) || safeStr(ls?.name) || safeStr(ls?.id);
      const label = safeStr(ls?.label) || sel;
      if (!sel) continue;
      const matched = srcSelects.find((f) => !dedupe.has(`feature:${f.id}`) && matchesFeature(f, sel, label));
      const opt = matched?.option_hint || safeStr(asArray<string>(ls?.options)[0]) || "";
      const scope = matched ? `feature:${matched.id}` : `${routePath}|select:${sel}`;
      const stepName = matched
        ? `Source select: ${matched.label} (${matched.source.path}:${matched.source.line})`
        : `Select option: ${label.slice(0, 40)}`;
      if (pushUnique({ name: stepName, action: "select", target: sel, value: opt }, scope)) {
        usedSelects.add(i);
      }
    }

    // Inputs & Textareas
    let filledAny = false;
    const filterTargets: string[] = [];
    for (let i = 0; i < liveInputs.length && i < 10; i++) {
      const inp = liveInputs[i];
      const sel = safeStr(inp?.selector);
      const label = safeStr(inp?.label) || safeStr(inp?.placeholder) || safeStr(inp?.name) || safeStr(inp?.id);
      const target = sel || label;
      if (!target) continue;
      const matched = srcInputs.find(
        (f) =>
          matchesFeature(f, sel, label) ||
          Boolean(f.placeholder && inp?.placeholder && f.placeholder === inp.placeholder),
      );
      // Shared layout forms (e.g. EarlyAccessForm in Layout.tsx) are deduped globally via `feature:<id>`;
      // page-specific forms (e.g. Careers application form on `/careers`) execute on their route.
      if (matched && matched.shared_layout && dedupe.has(`feature:${matched.id}`)) continue;
      const scope = matched
        ? matched.shared_layout || !matched.route_hint
          ? `feature:${matched.id}`
          : `${routePath}|feature:${matched.id}`
        : `${routePath}|input:${target}`;
      const val = syntheticValueForField(
        matched?.label || label,
        matched?.input_type || safeStr(inp?.type),
        matched?.placeholder || safeStr(inp?.placeholder),
      );
      const stepName = matched
        ? `Source input: ${matched.label} (${matched.source.path}:${matched.source.line})`
        : `Fill input: ${label.slice(0, 44)}`;
      if (pushUnique({ name: stepName, action: "fill", target, value: val }, scope)) {
        if (matched) dedupe.add(`feature:${matched.id}`);
        usedInputs.add(i);
        filledAny = true;
        const filterContext = [
          label,
          safeStr(inp?.placeholder),
          safeStr(inp?.name),
          safeStr(inp?.id),
          safeStr(inp?.type),
        ].join(" ");
        if (/filter|search/i.test(filterContext)) filterTargets.push(target);
      }
    }
    if (filledAny) {
      push({ name: `Screenshot of populated form fields (${routePath})`, action: "screenshot", target: "", value: "" });
      push({ name: `Assert no page errors after form interaction (${routePath})`, action: "assert_no_errors", target: "", value: "" });
      // A filled filter/search box can hide the links exercised later in the
      // pass; restore it so subsequent steps observe the unfiltered page.
      for (const filterTarget of filterTargets) {
        push({ name: `Clear filter after form interaction (${routePath})`, action: "fill", target: filterTarget, value: "" });
      }
    }
  }

  // 7. Interactive Buttons (in-page mode switches, modals, filters, CTAs; global header/footer buttons deduped once)
  const srcButtons = byKind("button");
  if (!isLiveDom) {
    for (const f of srcButtons.slice(0, 10)) {
      if (destructive.test(f.label) || externalOauth.test(f.label)) continue;
      pushUnique(
        { name: `Source button: ${f.label} (${f.source.path}:${f.source.line})`, action: "click", target: f.selector_hint || f.label, value: "" },
        `feature:${f.id}`,
      );
    }
  } else {
    // Prioritize page-body non-submit buttons first, then global chrome buttons (once per run)
    const orderedButtons = liveButtons
      .map((b, idx) => ({ b, idx }))
      .filter(({ b }) => {
        const text = safeStr(b?.text);
        if (!text && !safeStr(b?.selector)) return false;
        if (b?.isSubmit) return false; // Handled safely in the form validation step above
        if (destructive.test(text) || externalOauth.test(text)) return false;
        return true;
      })
      .sort((a, b) => Number(Boolean(a.b?.inChrome)) - Number(Boolean(b.b?.inChrome)));

    let buttonClicksOnPage = 0;
    for (const { b, idx } of orderedButtons) {
      if (buttonClicksOnPage >= 8) break;
      const text = safeStr(b?.text);
      const sel = safeStr(b?.selector);
      const target = sel || text;
      if (!target) continue;
      const matched = srcButtons.find((f) => matchesFeature(f, sel, text));
      if (b?.inChrome && dedupe.has(`global-btn:${normalizeMatchText(text || target)}`)) continue;
      if (matched && matched.shared_layout && dedupe.has(`feature:${matched.id}`)) continue;

      const scope = b?.inChrome
        ? `global-btn:${normalizeMatchText(text || target)}`
        : matched
          ? matched.route_hint
            ? `${routePath}|feature:${matched.id}`
            : `feature:${matched.id}`
          : `${routePath}|btn:${normalizeMatchText(text || target)}`;

      const stepName = matched
        ? `Source button: ${text || matched.label} (${matched.source.path}:${matched.source.line})`
        : `Click button: ${(text || target).slice(0, 48)}`;

      if (
        pushUnique(
          {
            name: stepName,
            action: "click",
            target: text || target,
            value: "",
            options: { stayOnPageUrl: pageUrl, captureNavigatedScreenshot: !b?.inChrome },
          },
          scope,
        )
      ) {
        if (matched) dedupe.add(`feature:${matched.id}`);
        if (b?.inChrome) dedupe.add(`global-btn:${normalizeMatchText(text || target)}`);
        usedButtons.add(idx);
        buttonClicksOnPage++;
        if (!b?.inChrome) {
          push({ name: `Screenshot after '${(text || target).slice(0, 32)}' (${routePath})`, action: "screenshot", target: "", value: "" });
        }
      }
    }
  }

  // 7b. Every route-relevant source feature is either paired with a live control
  // or recorded as a coverage gap. A source snippet may not match the deployed
  // DOM (different fixture revision); emitting an unmatched step as a product
  // failure would be a false positive, so it is skipped with an explicit reason.
  const liveSignatures = new Set<string>();
  const liveSelectorsByHref = new Map<string, string>();
  const liveSelectorsByLabel = new Map<string, string>();
  for (const item of [
    ...asArray<any>(discovery?.links),
    ...asArray<any>(discovery?.forms),
    ...liveButtons,
    ...liveInputs,
    ...liveSelects,
    ...liveToggles,
    ...liveSliders,
    ...liveTabs,
    ...liveAccordions,
  ]) {
    const selector = safeStr(item?.selector);
    const href = safeStr(item?.href);
    const text = safeStr(item?.text || item?.label || item?.name || item?.placeholder);
    if (selector) {
      liveSignatures.add(`selector:${selector}`);
      if (href && !liveSelectorsByHref.has(href)) liveSelectorsByHref.set(href, selector);
      const normalizedText = normalizeMatchText(text);
      if (normalizedText && !liveSelectorsByLabel.has(normalizedText)) liveSelectorsByLabel.set(normalizedText, selector);
    }
    if (href) {
      liveSignatures.add(`href:${href}`);
      liveSignatures.add(`label:${normalizeMatchText(href)}`);
    }
    const normalizedText = normalizeMatchText(text);
    if (normalizedText) liveSignatures.add(`label:${normalizedText}`);
  }
  const skippedSourceFeatures: Array<{ id: string; reason: string }> = [];
  const coveredByCrawl: Array<{ id: string; route: string }> = [];
  for (const f of candidateFeatures) {
    if (f.kind === "route") continue;
    const key = `feature:${f.id}`;
    if (dedupe.has(key)) continue;
    const normalizedRoutePath = routePath.replace(/\/+$/, "") || "/";
    const hint = (f.route_hint || "").replace(/\/+$/, "") || "/";
    if (
      f.kind === "link" &&
      planOptions.multiTargetRun &&
      normalizedRoutePath === "/" &&
      hint.startsWith("/") &&
      !hint.startsWith("//")
    ) {
      // Homepage/example catalog links are navigation to routes already visited
      // by the bounded crawl. Clicking all of them would churn the single CDP
      // session and is redundant; record the destination as crawl-covered.
      coveredByCrawl.push({ id: f.id, route: hint });
      dedupe.add(key);
      continue;
    }
    if (destructive.test(f.label) || externalOauth.test(f.label)) {
      skippedSourceFeatures.push({ id: f.id, reason: "unsafe or destructive action" });
      continue;
    }
    if (f.kind === "input" && /file/i.test(f.input_type ?? "")) {
      skippedSourceFeatures.push({ id: f.id, reason: "file upload would write to the live target" });
      continue;
    }
    const target = f.selector_hint || f.label;
    if (!target) {
      skippedSourceFeatures.push({ id: f.id, reason: "no selector or label" });
      continue;
    }
    if (isLiveDom) {
      const present =
        (f.selector_hint && liveSignatures.has(`selector:${f.selector_hint}`)) ||
        (f.label && liveSignatures.has(`label:${normalizeMatchText(f.label)}`)) ||
        (f.label && liveSignatures.has(`href:${f.label}`));
      if (!present) {
        skippedSourceFeatures.push({ id: f.id, reason: "source feature not present in live DOM" });
        continue;
      }
    }
    let resolvedTarget = target;
    if (f.kind === "link" && !f.selector_hint && f.label) {
      resolvedTarget =
        liveSelectorsByHref.get(f.label) ||
        liveSelectorsByLabel.get(normalizeMatchText(f.label)) ||
        target;
    }
    let action: StepAction["action"];
    let value = "";
    if (f.kind === "toggle") action = "toggle";
    else if (f.kind === "slider") { action = "slide"; value = "30"; }
    else if (f.kind === "input") { action = "fill"; value = syntheticValueForField(f.label, f.input_type ?? "", f.placeholder ?? ""); }
    else if (f.kind === "select") {
      if (!f.option_hint) {
        skippedSourceFeatures.push({ id: f.id, reason: "no option hint" });
        continue;
      }
      action = "select";
      value = f.option_hint;
    } else if (f.kind === "form") action = "assert_no_errors";
    else action = "click";
    const stepName = `Source ${f.kind}: ${f.label} (${f.source.path}:${f.source.line})`;
    pushUnique(
      {
        name: stepName,
        action,
        target: resolvedTarget,
        value,
        options: { stayOnPageUrl: pageUrl },
      },
      key,
    );
  }
  const sourceFeatureCoverage = candidateFeatures.filter((f) => f.kind !== "route").reduce(
    (acc, f) => {
      if (dedupe.has(`feature:${f.id}`)) acc.covered += 1;
      else acc.uncovered += 1;
      return acc;
    },
    { total: candidateFeatures.filter((f) => f.kind !== "route").length, covered: 0, uncovered: 0 },
  );

  // 8. Link navigation probes ONLY when running on a single target (avoid redundant goto loops during multi-page crawl)
  if (!planOptions.multiTargetRun) {
    const baseOrigin = (() => {
      try {
        return new URL(baseUrl).origin;
      } catch {
        return "";
      }
    })();
    const sameOriginLinks = asArray<any>(discovery?.links).filter((l) => {
      const href = safeStr(l?.href);
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) return false;
      try {
        const u = new URL(href, pageUrl);
        return !baseOrigin || u.origin === baseOrigin;
      } catch {
        return href.startsWith("/");
      }
    });
    let navClicks = 0;
    for (const l of sameOriginLinks.slice(0, 8)) {
      if (navClicks >= 3) break;
      const href = safeStr(l?.href);
      const text = safeStr(l?.text);
      if (!href) continue;
      let abs = "";
      try {
        const u = new URL(href, pageUrl);
        if (u.href === pageUrl || (baseOrigin && u.origin !== baseOrigin)) continue;
        abs = u.href;
      } catch {
        continue;
      }
      if (pushUnique({ name: `Navigate via link: ${(text || abs).slice(0, 40)}`, action: "goto", target: abs, value: "" }, `route:${abs}`)) {
        push({ name: "Screenshot after navigation", action: "screenshot", target: "", value: "" });
        push({ name: "Return to base page", action: "goto", target: pageUrl, value: "" });
        navClicks++;
      }
    }
  }

  void usedToggles.size;
  void usedSliders.size;
  void usedTabs.size;
  void usedAccordions.size;
  void usedInputs.size;
  void usedSelects.size;
  void usedButtons.size;

  push({ name: `Final state screenshot (${routePath})`, action: "screenshot", target: "", value: "" });

  return {
    title: `${features.length ? "Source-backed" : "Auto"} interaction regression (${routePath}): ${safeStr(discovery?.title) || pageUrl}`,
    steps,
    source: features.length ? "source-backed+cdp-auto" : "auto-discovered",
    model: "cdp-auto",
    target_url: pageUrl || baseUrl,
    coverage: {
      route: routePath,
      source_features_on_route: sourceFeatureCoverage.total,
      source_features_covered: sourceFeatureCoverage.covered,
      source_features_uncovered: sourceFeatureCoverage.uncovered,
      skipped_source_features: skippedSourceFeatures,
      covered_by_crawl: coveredByCrawl,
    },
  };
}

export async function runAutomaticInteractions(opts: {
  call: CdpCall;
  sessionId?: string;
  baseUrl: string;
  evidence?: BrowserScenarioEvidenceStoreLike;
  timeoutMs?: number;
  label?: string;
  features?: SourceFeature[];
  dedupe?: Set<string>;
  multiTargetRun?: boolean;
}): Promise<ScenarioExecutionResult & { plan: ScenarioPlan }> {
  const page = new CdpInteractionPage({
    call: opts.call,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.evidence ? { evidence: opts.evidence } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  });
  await page.refreshUrl().catch(() => {});
  const plan = await discoverInteractionPlan(page, opts.baseUrl, opts.features ?? [], opts.dedupe ?? new Set<string>(), {
    ...(opts.multiTargetRun !== undefined ? { multiTargetRun: opts.multiTargetRun } : {}),
  });
  const exec = await executeScenarioPlan(page, plan, opts.evidence, {
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.label ? { label: opts.label } : {}),
  });
  return { ...exec, plan };
}
