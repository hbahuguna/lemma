# lemma feedback review service (self-hosted, optional)

Private, self-hosted review service for lemma's scoped feedback loop. This service is **off by default** and must be started explicitly (for example via `lemma feedback serve`).

## Properties

- Node.js only, **no external runtime dependencies**.
- Self-hosted deployment (run on your own infrastructure/machine).
- Issues **branded invitation links** scoped to a specific feedback request.
- Invitation tokens are **request-scoped and expiring**; tokens are never logged.
- Stores request/response context locally under `.lemma/feedback/` in the configured project root.
- Intended for private/internal review flows; do not expose publicly without your own access controls.

## Usage

Start explicitly (service is disabled unless invoked):

```bash
lemma feedback serve --root /path/to/project --port 8787
```

The service provides local endpoints to create feedback requests and submit scoped responses. Reviewers use invitation links containing a scoped, expiring token; responses are validated and ingested as redacted local context attached to originating findings/checks.

## Data handling

- Redaction is applied before persistence.
- Invitation tokens are never logged and are stored only as hashes in request records.
- All feedback is stored locally under `.lemma/feedback/<request_id>/`.

See ADR 0006 (LEM-156) and `BOARD.md` (LEM-169) for tier/privacy classification and acceptance criteria.
