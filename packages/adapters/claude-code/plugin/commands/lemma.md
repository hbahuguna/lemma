---
description: Run Lemma autonomous assessment agent
---

Run a Lemma assessment for: $ARGUMENTS

- If the user asks for help/list/commands, show available Lemma command templates and usage.
- For assessment goals, run through the host-neutral agent flow (bounded, deterministic-harness-owned, no invented findings/scores).
- Use shared command builders/catalog; never request or persist raw secrets/tokens.
- CLI: `lemma`, personas dir: `<personas-dir>`, state root: `.lemma`.
