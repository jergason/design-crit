# Design Crit

Multi-agent adversarial design review tool. Engineers submit design docs, a panel of opinionated agent-critics reviews them from different angles, produces a revised doc and review notes.

## Project Status

Early design phase. Design doc at `docs/design-doc.md`.

## Key Decisions

- Rounds-based pacing for v1
- CLI adapter first, UI-agnostic engine
- All agents claude-backed for prototype, multi-harness later
- Facilitator agent manages discussion flow and compression
- File-based protocol marked for future exploration
