---
id: fixture-specialist
name: Fixture Specialist
version: 1.0
active: true
rank: 7
quoted: "quoted value"
inline: [functional, 42, false]
domains:
  - functional
  - data_integrity
tools:
  - source_inventory
  - test_inventory
checks:
  - static.inventory
  - static.dependencies
---

# Fixture Specialist

Intro text that is not inside a required section.

## Role

Judge the release outcome.

## Available tools

| Tool | Use | Boundary |
| --- | --- | --- |
| `source_inventory` | Read inventory. | Read-only. |

## Output schema

```json
{"type": "object", "required": ["title"], "properties": {"title": {"type": "string"}}}
```

## Blocker schema

```json
{"type": "object", "required": ["persona"], "properties": {"persona": {"type": "string"}}}
```

## Refusal handling

Refuse when evidence is outside the declared tools.
