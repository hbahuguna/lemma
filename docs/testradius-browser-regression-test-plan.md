# TestRadius (https://testradius.dev) — Comprehensive Browser Regression Test Plan

**Target:** https://testradius.dev  
**Scope:** Full public, same-origin user-facing experience (all reachable pages/routes, navigation, content, interactions, and states)  
**Goal:** Test all discovered features with long-running browser regression coverage, including **button clicks, forms, toggles, scrolling, navigation, links, responsive behavior, and error handling**.  
**Plan version:** 2026-11-17  
**Discovery basis:** Crawled browser inspection run `browser-1db6a573-a79c-4193-ad5c-f2feca05b66c` (`/Users/skaparwan/github/Test-Radius/.lemma/evidence/browser-1db6a573-a79c-4193-ad5c-f2feca05b66c/`) plus observed routes/links from DOM snapshots.

## 1. Discovered routes/features inventory (public)

| Area | Route(s) | Observed/discoverable features | Notes |
|---|---|---|---|
| Landing / Home | `/` | Hero heading/CTA(s), primary navigation, feature/value sections, footer links, external demo/booking link (`https://zcal.co/i/suLjJzcq`), mailto links, login/jobs CTAs | Main entry point; scroll-heavy content |
| Docs | `/docs`, `/docs/architecture`, `/docs/troubleshooting`, `/docs/usage/tia`, `/docs/usage/github-app`, `/docs/deploy/docker` (and any other linked docs pages) | Docs navigation/sidebar/section links, headings/content rendering, code/steps readability, in-page anchors (if any), cross-links between docs | Crawl and verify each reachable docs page |
| Blog | `/blog` (and any linked post pages) | Blog index/listing, post links/cards, metadata/content rendering | Discover and test individual posts if linked |
| Pricing | `/pricing` | Pricing tiers/plans, plan CTAs/buttons, feature comparisons, billing-period toggle if present (monthly/yearly), FAQ/accordion if present, contact/sales/demo links | Check for interactive toggles/tabs/accordions |
| Jobs | `/jobs` | Careers content, role listings/links (if any), orientation sheet link (`/orientation-sheet.pdf`), application/contact mailto links | Verify external/file links |
| Login | `/login` | Authentication UI (likely email/username/password inputs, submit button, SSO/provider buttons if present, forgot-password/signup links if present, validation/error states) | **Auth-gated/protected flows are coverage gaps without test credentials**; test UI/validation behavior safely |
| Global | All pages | Header/nav, logo/home link, footer, responsive layout, keyboard focus visibility (where observable), 404/error handling (if testable safely) | Consistent shell across routes |

## 2. Test environment and data

- **Browser:** Chrome/Chromium (headed preferred for interactive observation; headless for CI/capture)
- **Viewports:** Desktop (e.g. 1440x900), tablet (e.g. 834x1112), mobile (e.g. 390x844)
- **Test data:** No real credentials/secrets. Use synthetic/invalid inputs for validation tests (e.g. empty submit, malformed email). Do not create accounts, submit real transactions, or access third-party authenticated systems.
- **Preconditions:** Site reachable over HTTPS; stable network; no blocking WAF/captcha for public pages (record if encountered).

## 3. Detailed regression test cases

Legend: **Automation** = `Automated (lemma browser)` | `Automatable (with interaction tooling/scenarios)` | `Manual/agent-assisted` | `Blocked/Gap`

### 3.1 Global / Cross-cutting

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| G-01 | Page load | Navigate to each discovered route; wait for load/network idle | HTTP 200, correct final URL, page renders visible content, no navigation crash | Automated (lemma browser) | P0 |
| G-02 | Console/page errors | Observe console and uncaught page errors on each route and after interactions | No console errors/page exceptions | Automated on load; interaction-triggered errors Automatable with interaction tooling | P0 |
| G-03 | Network requests | Observe requests on load and during interactions | No failed or unexpected 4xx/5xx responses for required assets/API calls | Automated on load; interaction-triggered Automatable | P0 |
| G-04 | Content sanity | Verify title, primary heading(s), and meaningful visible text on each route | Non-empty descriptive title, coherent heading/content | Automated (lemma browser) | P1 |
| G-05 | Link integrity | Enumerate all links on each route | No empty/placeholder/javascript: links, no insecure links on HTTPS pages, safe `rel` for new-tab links | Automated (lemma browser) | P1 |
| G-06 | Global navigation (clicks) | Click each header/nav item and logo/home link from multiple pages | Correct route loads, active state updates (if present), no broken navigation | Automatable (click + verify URL/content) | P0 |
| G-07 | Scroll behavior | Scroll to bottom and back to top on long pages (home, docs, pricing, blog, jobs); use in-page anchors if present | Content loads/renders correctly, no layout break/sticky-nav issues, anchor jumps to correct section | Automatable (scroll + screenshot/assert) | P1 |
| G-08 | Responsive/mobile | Test key pages at mobile/tablet/desktop viewports; open/close mobile menu if present (button click/toggle) | No horizontal overflow, readable text/CTAs, menus functional | Partially automatable (viewport checks) + interaction for menus | P1 |
| G-09 | External links | Click/inspect external CTAs (e.g. zcal booking, mailto, PDF) | Correct `href`, safe target/rel; mailto/PDF/external open as intended (record if not auto-followed) | Partially automated (inspection) + manual verification | P2 |
| G-10 | 404/unknown route | Navigate to a safe non-existent same-origin path (if appropriate) | User-friendly 404 or redirect behavior, no server error page leak | Automatable (navigation check) | P2 |

### 3.2 Landing / Home (`/`)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| H-01 | Hero CTAs (buttons/links click) | Click primary and secondary hero CTAs/buttons (e.g. login/get started/demo/book) | Navigate to intended destination or open intended action/modal | Automatable (click interactions) | P0 |
| H-02 | Section navigation/scroll | Scroll through all homepage sections; click any in-page “learn more”/anchor links | Smooth/expected scroll, sections visible, anchors land correctly | Automatable | P1 |
| H-03 | Repeated CTAs | Click login/jobs CTAs appearing in multiple sections/footer | Consistent correct destinations | Automatable | P1 |
| H-04 | Visual/content completeness | Verify key marketing copy, images/icons (if any), and footer render after full scroll | No missing/broken content | Manual/agent-assisted + screenshot evidence | P2 |

### 3.3 Docs (`/docs` and subpages)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| D-01 | Docs landing | Open `/docs` and verify sidebar/index/content | Getting started/content renders, navigation visible | Automated on load + interaction for nav | P0 |
| D-02 | Docs sidebar/link clicks | Click each docs navigation item/link (e.g. Architecture, Troubleshooting, Usage/TIA, Usage/GitHub App, Deploy/Docker, and all other discovered pages) | Correct page loads with expected heading/content, URL updates | Automatable (click + crawl) | P0 |
| D-03 | In-page anchors/TOC | Click table-of-contents/anchor links within docs pages (if present); scroll long docs | Jumps to correct section, scroll position correct | Automatable | P1 |
| D-04 | Code blocks/copy buttons | If code blocks or copy buttons exist, click copy and verify affordance/feedback (without pasting secrets) | Button responds, feedback shown (e.g. “copied”) | Automatable/Manual (clipboard may be restricted) | P2 |
| D-05 | Breadcrumbs/back nav | Use breadcrumbs or back navigation controls if present | Correct parent/previous page | Automatable | P2 |

### 3.4 Blog (`/blog` and posts)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| B-01 | Blog index | Open `/blog`; scroll through listing | Posts/list items render (or clear empty state) | Automated + scroll Automatable | P1 |
| B-02 | Post navigation clicks | Click each visible blog post/card/link | Post page loads with content, correct URL/title | Automatable | P1 |
| B-03 | Post content/links | Scroll post, click internal/external links within post | Content readable, links valid/safe | Automatable/Manual | P2 |
| B-04 | Pagination/load more | If pagination or “load more” exists, click controls | Additional posts load correctly, no duplicates/errors | Automatable | P2 |

### 3.5 Pricing (`/pricing`)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| P-01 | Plans display | Open `/pricing`; scroll full page | All tiers/features/prices/CTAs visible and readable | Automated on load + scroll Automatable | P0 |
| P-02 | Billing toggle (if present) | Click monthly/yearly (or equivalent) toggle/switch/tabs | Prices/features update correctly, selected state visible | Automatable (toggle/click + assert) | P0 |
| P-03 | Plan CTAs (buttons/links click) | Click each plan CTA (e.g. start/login/contact/demo) | Correct destination/action (login, mailto, booking, etc.) | Automatable | P0 |
| P-04 | FAQ/accordion (if present) | Click each FAQ/accordion item to expand/collapse | Content expands/collapses correctly, only intended state changes | Automatable | P1 |
| P-05 | Comparison/table interactions | If comparison table has tabs/filters/horizontal scroll on mobile, interact with them | Correct data shown, usable on small screens | Automatable/Manual | P2 |

### 3.6 Jobs (`/jobs`)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| J-01 | Jobs page load/scroll | Open `/jobs`, scroll through content | Careers content and CTAs render | Automated + scroll Automatable | P1 |
| J-02 | Role/listing clicks (if present) | Click any role listings or detail links | Correct detail view/page opens | Automatable | P1 |
| J-03 | Orientation sheet link | Click `/orientation-sheet.pdf` link | PDF opens/downloads in new context as expected; link target/rel safe | Partially automated (inspection) | P2 |
| J-04 | Contact/application links | Click mailto/application/booking links | Correct `href` and behavior | Partially automated | P2 |

### 3.7 Login (`/login`) — UI and safe validation (no real auth)

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| L-01 | Login page load | Open `/login` | Login UI renders (form/fields/buttons/providers as available), no errors | Automated on load | P0 |
| L-02 | Form fields (fill) | Focus and type into email/username and password fields with synthetic values | Inputs accept text, masking works for password, labels/placeholders usable | Automatable (form fill) **Gap in current CLI automation** | P0 |
| L-03 | Empty/invalid submit (button click) | Click submit with empty fields; submit invalid email/short input | Client/server validation messages shown, no crash, no sensitive info leaked | Automatable **Gap in current CLI automation** | P0 |
| L-04 | Password visibility toggle (if present) | Click show/hide password toggle/button | Input type/visibility toggles correctly, icon/state updates | Automatable **Gap in current CLI automation** | P1 |
| L-05 | SSO/provider buttons (if present) | Click SSO/provider buttons (e.g. Google/GitHub) without completing third-party auth | Redirect/initiation behaves safely or shows expected flow start; record external/auth dependency | Automatable with constraints / Manual | P1 |
| L-06 | Forgot password / signup links (if present) | Click forgot-password/signup/create-account links | Correct navigation/modal/form shown | Automatable **Gap in current CLI automation** | P1 |
| L-07 | Authenticated flows (post-login dashboard, settings, etc.) | Login with valid test account and exercise protected features | **BLOCKED/GAP** without provisioned test credentials and environment access | Blocked (credential/environment gap) | P0 |

### 3.8 Error handling & edge cases

| ID | Feature | Test case (steps) | Expected result | Automation | Priority |
|---|---|---|---|---|---|
| E-01 | Slow/failed asset resilience | Observe behavior under normal load; note any degraded states | Graceful handling, no unhandled crashes | Observation/manual | P2 |
| E-02 | Repeated navigation/refresh | Refresh pages and navigate back/forward across routes | State and content remain consistent | Automatable | P2 |
| E-03 | Input edge cases (forms) | Long strings, special chars, whitespace-only in public forms (where safe) | Proper validation/sanitization, no UI break | Automatable **Gap in current CLI automation** | P2 |

## 4. Execution strategy

1. **Discovery & crawl (automated):** `lemma browser <url> --crawl --max-pages 25 --timeout-ms 120000` (repeat per major section if needed) to capture routes, load/console/network/content/link evidence and screenshots.
2. **Automated regression checks (current tooling):** For every crawled route, execute `browser.load`, `browser.console`, `browser.network`, `browser.content`, `browser.links` and collect `.lemma/evidence/<run_id>/` artifacts.
3. **Interactive scenarios (clicks/forms/toggles/scroll) — target state:** Execute via supported scenario/interaction tooling or agent-driven browser automation with evidence capture (screenshots/video/DOM/network/console) per step.
4. **Manual/agent-assisted verification:** For interactions not automatable by current CLI, perform and record evidence explicitly; otherwise mark **Blocked/Not automated** with reason.
5. **Gap handling:** Auth-gated, destructive, third-party, captcha-protected, or credential-dependent flows are reported as coverage gaps (never pass, never inflate confidence).

## 5. Deliverables

- This test plan (`docs/testradius-browser-regression-test-plan.md`)
- Automated browser evidence runs under `.lemma/evidence/browser-*/` (commands, run IDs, manifests, screenshots, DOM/console/network logs)
- Execution report summarizing: routes tested, pass/fail/blocked per test case, findings with repro/evidence, and interaction automation gaps

## 6. Current automation capability note

`lemma browser` currently provides automated, evidence-backed checks for **page load/navigation, console/page errors, network failures, content/title/heading sanity, and link integrity** with crawl/multi-page capture. **Rich UI interactions (button clicks, form filling/submission, toggles/switches, dropdowns/accordions/modals, scrolling assertions, drag/drop)** are not fully automated by the current CLI check set and require scenario/interaction tooling or agent-driven execution; such cases must be executed explicitly where supported or reported as coverage gaps in this plan.
