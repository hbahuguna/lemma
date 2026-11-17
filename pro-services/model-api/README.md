# Lemma Pro — TAI-style Fine-tuned QA Model API

OpenAI-compatible `POST /v1/chat/completions` service for lemma's Pro tier.

## Versioned model

- **Model ID (versioned):** `lemma-qa-ft-v1`
- **API version/base path:** `v1` / `/v1/chat/completions`
- **Wire format:** OpenAI Chat Completions (non-streaming JSON response and streaming SSE `chat.completion.chunk` events terminated by `data: [DONE]`)

## Authentication, licensing, and metering

- **Licensing:** Unlicensed invocation returns `ProUnavailableError` (no Pro capability execution without a valid Pro entitlement; reuses LEM-114/LEM-117 entitlement contracts).
- **Authorization:** Requests must present valid API credentials (Bearer token / `x-api-key`). Unauthorized requests are rejected with a typed error (`ModelApiUnauthorizedError`) **before inference**.
- **Metering:** Each completion request is metered through the existing metering envelope (LEM-113) via `@lemma/cloud/metering` (`MeteringEmitter`), emitting a schema-validated envelope event to the configured sink.

## Training data provenance

- **Base family:** Fine-tuned from a general-purpose instruction-following language model (documented base checkpoint lineage maintained in internal training records for the released `lemma-qa-ft-v1` artifact).
- **Fine-tuning corpus (documented):** Curated, consented QA pairs and evaluation-oriented instruction data derived from (a) synthetic QA scenarios authored for software quality/release-confidence workflows, (b) vetted public-domain/openly-licensed QA exemplars, and (c) anonymized, opt-in product interaction patterns reviewed for safety and relevance. No raw customer secrets or unredacted tenant data are included in training artifacts.
- **Data handling:** Training inputs are filtered/redacted for credentials and sensitive content prior to inclusion; provenance and dataset manifests are tracked per model version.

## Evaluation results (documented)

- **Conformance/wire:** Validated against a repo-owned OpenAI-compatible client fixture for non-streaming and streaming `chat/completions` responses (see `fixtures/openai-client.ts` and `packages/pro/test/model-api/*`).
- **Behavioral QA checks:** Evaluated on an internal QA prompt suite for response structure, instruction-following, and refusal/safety guardrails appropriate to QA assistance.
- **Metering/auth/licensing gates:** Verified that unauthorized requests are rejected before inference, unlicensed invocation is refused, and requests emit LEM-113 metering envelope events.
- **Release gate:** Model/API changes require passing the repo test suite for this service; quantitative benchmark deltas are recorded in release notes for promoted model revisions.

## Known limitations

- **Not a source of truth:** Outputs may be incomplete, outdated, or incorrect; responses must be independently verified against evidence and system state.
- **No autonomous actions:** The API generates text only; it does not execute checks, modify systems, or produce evidence artifacts.
- **Context sensitivity:** Quality depends on provided prompts/context; ambiguous or underspecified inputs can yield misleading answers.
- **Domain coverage:** Tuned for lemma QA/release-confidence assistance; performance outside this domain is not guaranteed.
- **Determinism:** Inference behavior may vary across deployments/configurations; tests in-repo use deterministic service behavior where applicable.

## Important notice

**This model never claims to replace human review.** It is an assistive QA tool; final release, risk, and correctness decisions require qualified human judgment and corroborating evidence.
