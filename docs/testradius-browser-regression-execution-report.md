# TestRadius Browser Regression — Execution Report

**Target:** https://testradius.dev  
**Plan:** `docs/testradius-browser-regression-test-plan.md` (2026-11-17)  
**Executed:** 2026-11-17  
**Executor:** Lemma CLI/browser inspection (automated checks) + plan-based gap assessment

## 1. Automated execution performed

### Run A — Comprehensive crawled browser inspection (primary evidence)
- **Command:**  
  `node /Users/skaparwan/github/lemma/packages/cli/dist/cli.js browser https://testradius.dev --crawl --max-pages 12 --timeout-ms 45000 --headless`
- **Workspace/root for artifacts:** `/Users/skaparwan/github/Test-Radius`
- **Run ID:** `browser-1db6a573-a79c-4193-ad5c-f2feca05b66c`
- **Status:** `completed` (not blocked)
- **Scoped checks executed:** `browser.load`, `browser.console`, `browser.network`, `browser.content`, `browser.links` (5/5 **passed**, 0 failed/blocked/errored)
- **Evidence:** `/Users/skaparwan/github/Test-Radius/.lemma/evidence/browser-1db6a573-a79c-4193-ad5c-f2feca05b66c/` (manifest, per-route navigation/DOM snapshots/console/network logs/screenshots)

**Routes/pages captured and checked (evidence-backed):**
1. `/` (landing) — HTTP 200, title "TestRadius — Stop flaky tests. Ship with confidence.", 1 h1, 3843 chars visible text, 16 reqs (no 4xx/5xx), 11 links OK
2. `/docs` — captured (route-1-docs artifacts)
3. `/blog` — captured (route-2-blog artifacts)
4. `/pricing` — captured (route-3-pricing artifacts)
5. `/jobs` — captured (route-4-jobs artifacts)
6. `/login` — captured (route-5-login artifacts), HTTP 200

**Observed no console/page errors and no failed/unexpected 4xx/5xx requests** in captured load evidence for the automated checks (per observations/route logs).

### Run B — Additional verification pass
- **Command:**  
  `node /Users/skaparwan/github/lemma/packages/cli/dist/cli.js browser https://testradius.dev --crawl --max-pages 2 --timeout-ms 30000`
- **Run ID:** `browser-bc980726-0c08-4f74-984d-0eece8dabe9c`
- **Status:** `completed`, 5/5 passed (headless-capable run in this environment; headed launch depends on GUI session)

## 2. Test case execution status (mapped to plan)

### 3.1 Global / Cross-cutting
| ID | Status | Evidence / Notes |
|---|---|---|
| G-01 Page load | **PASS (automated, crawled routes)** | Run A: all captured routes loaded successfully (HTTP 200/final URLs in navigation artifacts). Additional linked docs subpages beyond crawled set: **Not fully covered** (gap — increase crawl/pages or run targeted passes). |
| G-02 Console/page errors | **PASS on load (automated)** | No console errors/unhandled page errors observed on captured routes at load. **Gap:** interaction-triggered errors (after clicks/fills/toggles/scroll events) not automated. |
| G-03 Network requests | **PASS on load (automated)** | No failed/unexpected 4xx/5xx on captured routes at load. **Gap:** interaction-triggered requests not automated. |
| G-04 Content sanity | **PASS (automated, captured routes)** | Title/headings/visible text present per route snapshots/observations. |
| G-05 Link integrity | **PASS (automated, captured routes)** | No placeholder/insecure/missing-noopener issues reported in observed link checks. Full interaction/click-through of every link: **Partially covered** (inspection automated; click navigation of all links not fully automated). |
| G-06 Global navigation clicks | **NOT AUTOMATED (gap)** | Requires click interactions and per-click verification across pages. |
| G-07 Scroll behavior | **NOT AUTOMATED (gap)** | Page screenshots captured but scroll interactions/assertions not automated. |
| G-08 Responsive/mobile | **PARTIAL / GAP** | Viewport-level/visual behavior not comprehensively asserted via interaction; mobile menu toggle clicks not automated. |
| G-09 External links | **PARTIAL** | `href/target/rel` observed (e.g. zcal `_blank` with `noopener noreferrer`, mailto, PDF links). Actual external navigation/download behavior: **Manual/blocked by safe automation constraints**. |
| G-10 404/unknown route | **NOT EXECUTED (gap)** | Safe 404 navigation check not run in this execution. |

### 3.2 Landing / Home (`/`)
| ID | Status | Evidence / Notes |
|---|---|---|
| H-01 Hero CTAs clicks | **NOT AUTOMATED (gap)** | CTAs/links discovered (e.g. `/login`, `/jobs`, booking) but click flows not executed. |
| H-02 Section scroll/anchors | **NOT AUTOMATED (gap)** | Scroll/anchor interactions not automated. |
| H-03 Repeated CTAs | **NOT AUTOMATED (gap)** | Destinations partially inferable from hrefs; click consistency not verified. |
| H-04 Visual/content completeness | **PARTIAL** | Screenshot captured (`landing-page.png`); full visual/content review is agent-assisted/manual. |

### 3.3 Docs (`/docs` and subpages)
| ID | Status | Evidence / Notes |
|---|---|---|
| D-01 Docs landing | **PASS on load (automated)** | `/docs` captured (`route-1-docs-*`), h1 "Getting Started", links/content observed. |
| D-02 Docs sidebar/link clicks | **PARTIAL / GAP** | `/docs` captured; subpages discovered in links (`/docs/architecture`, `/docs/troubleshooting`, `/docs/usage/tia`, `/docs/usage/github-app`, `/docs/deploy/docker`, etc.) but **not all individually crawled/click-verified** in this run. Requires additional targeted crawls/click automation. |
| D-03 In-page anchors/TOC | **NOT AUTOMATED (gap)** | Interaction not automated. |
| D-04 Code blocks/copy buttons | **NOT AUTOMATED (gap)** | UI control interactions not automated/confirmed. |
| D-05 Breadcrumbs/back nav | **NOT AUTOMATED (gap)** | Not verified. |

### 3.4 Blog (`/blog`)
| ID | Status | Evidence / Notes |
|---|---|---|
| B-01 Blog index load/scroll | **PASS on load (automated)** / scroll **GAP** | `/blog` captured (`route-2-blog-*`). Scroll behavior not automated. |
| B-02 Post navigation clicks | **NOT AUTOMATED / UNKNOWN** | Individual posts not enumerated/clicked in this run. |
| B-03 Post content/links | **NOT EXECUTED (gap)** | Depends on post discovery. |
| B-04 Pagination/load more | **NOT AUTOMATED (gap)** | Control presence/behavior not verified. |

### 3.5 Pricing (`/pricing`)
| ID | Status | Evidence / Notes |
|---|---|---|
| P-01 Plans display load/scroll | **PASS on load (automated)** / scroll **GAP** | `/pricing` captured (`route-3-pricing-*`), h1/pricing content observed. |
| P-02 Billing toggle (if present) | **NOT AUTOMATED (gap)** | Toggle/switch interaction not executed. |
| P-03 Plan CTAs clicks | **NOT AUTOMATED (gap)** | CTA click flows not executed. |
| P-04 FAQ/accordion (if present) | **NOT AUTOMATED (gap)** | Expand/collapse interactions not executed. |
| P-05 Comparison interactions | **NOT AUTOMATED (gap)** | Not verified. |

### 3.6 Jobs (`/jobs`)
| ID | Status | Evidence / Notes |
|---|---|---|
| J-01 Jobs load/scroll | **PASS on load (automated)** / scroll **GAP** | `/jobs` captured (`route-4-jobs-*`). |
| J-02 Role/listing clicks | **NOT AUTOMATED / UNKNOWN** | Role detail interactions not verified. |
| J-03 Orientation sheet link | **PARTIAL** | Link observed (`/orientation-sheet.pdf`, `_blank`, `noreferrer`); download/open not executed. |
| J-04 Contact/application links | **PARTIAL** | `mailto:jobs@testradius.dev` / `mailto:hello@testradius.dev` observed; click behavior not executed. |

### 3.7 Login (`/login`)
| ID | Status | Evidence / Notes |
|---|---|---|
| L-01 Login page load | **PASS on load (automated)** | `/login` captured (`route-5-login-*`), HTTP 200, 257 chars body text. Detailed form/control inventory not present in DOM snapshot; visual evidence in screenshot. |
| L-02 Form fields fill | **NOT AUTOMATED (gap)** | Current `lemma browser` CLI checks do not perform form filling. |
| L-03 Empty/invalid submit & validation | **NOT AUTOMATED (gap)** | Submit/click and validation assertions not automated. |
| L-04 Password visibility toggle | **NOT AUTOMATED (gap)** | Toggle interaction not automated. |
| L-05 SSO/provider buttons | **NOT AUTOMATED / CONSTRAINED** | Third-party auth flows not exercised; potential external dependency. |
| L-06 Forgot password/signup links | **NOT AUTOMATED (gap)** | Click/navigation not executed. |
| L-07 Authenticated flows | **BLOCKED (gap)** | No test credentials/provisioned environment provided; protected features not testable. |

### 3.8 Error handling & edge cases
| ID | Status | Evidence / Notes |
|---|---|---|
| E-01 Resilience | **NOT ASSESSED** | No fault-injection executed. |
| E-02 Repeated navigation/refresh | **NOT AUTOMATED (gap)** | Not executed. |
| E-03 Input edge cases | **NOT AUTOMATED (gap)** | Requires form interaction automation. |

## 3. Summary

- **Automated, evidence-backed coverage achieved:** 6 public routes/pages crawled and checked for load, console errors, network failures, content sanity, and link integrity — **all passed** in Run A (5/5 checks). No load-time console/page errors or failed/4xx/5xx requests observed on captured routes.
- **Not executed due to tooling limitations (current `lemma browser` CLI):** button clicks, form fills/submits, toggle/switch interactions, dropdown/accordion/modal interactions, scroll assertions, and most interaction-triggered state/error validations.
- **Blocked/gaps:** authenticated/protected flows (no test credentials), exhaustive click-through of every discovered link/control/subpage (partial crawl), third-party/external action completion (booking, mailto, PDF open/download behavior beyond inspection), 404 and edge-case scenarios not run.
- **Overall:** Public page health checks are strong for crawled routes, but **full feature regression including interactions is not complete** with current automated execution; interaction scenarios must be run with supported browser interaction/scenario tooling or agent-driven steps and recorded as evidence.

## 4. Evidence references
- Primary: `/Users/skaparwan/github/Test-Radius/.lemma/evidence/browser-1db6a573-a79c-4193-ad5c-f2feca05b66c/` (`manifest.json`, per-route `*-navigation.json`, `*-dom-snapshot.json`, `*-console-log.json`, `*-network-log.json`, screenshots)
- Secondary: `/Users/skaparwan/github/Test-Radius/.lemma/evidence/browser-bc980726-0c08-4f74-984d-0eece8dabe9c/`
- Test plan: `/Users/skaparwan/github/lemma/docs/testradius-browser-regression-test-plan.md`

## 5. Recommended next steps to fully execute interaction coverage
1. Run targeted crawls/passes to include all docs subpages and any blog posts not captured (increase `--max-pages` and/or run per-section).
2. Execute interaction scenarios (clicks, form fills/invalid+valid submits, toggles/accordions/tabs, scrolls, responsive menu) using supported scenario tooling or an agent-driven browser session that records step-by-step evidence (screenshots, DOM, console, network per action).
3. Provide safe test credentials via secure env/secret refs (never in chat/artifacts) to cover authenticated flows, or explicitly keep them as documented gaps.
4. Re-run automated checks after fixes/changes and compare evidence manifests across runs.
