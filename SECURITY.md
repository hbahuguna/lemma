# Security Policy

## Supported versions

`lemma` is pre-1.0. Security fixes are applied to the latest release line and `main` until a formal support policy is published.

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Please report security issues privately using **GitHub Private Vulnerability Reporting** for this repository:

- https://github.com/hbahuguna/lemma/security/advisories/new

If private reporting is unavailable, contact the maintainers through a private channel and include "SECURITY" in the subject so the report can be triaged promptly.

### What to include

- A clear description of the issue and affected package(s)/surface(s)
- Reproduction steps or a proof of concept (use synthetic/non-sensitive data only)
- Impact assessment and any known mitigations
- Version/commit, environment, and relevant configuration

### Disclosure process

- We will acknowledge receipt as soon as practical and investigate.
- Please allow reasonable time for validation and a fix before public disclosure.
- Coordinated disclosure details (advisory/CVE if applicable) will be handled with the reporter when possible.

## Security posture notes

- `lemma` treats targets and evidence as untrusted input; do not execute artifacts.
- Secrets/credentials/tokens must never be persisted or reported (see redaction/state/evidence invariants in `AGENTS.md`).
- Never include real credentials or live customer data in reports, fixtures, or commits. Suspected live credentials are escalation blockers, not evidence to copy.
