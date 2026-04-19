# Design Crit

> If only you could talk to the monsters...
>
> \- [Edge Magazine 1994 Doom Review](https://web.archive.org/web/20120104155012/http:/www.next-gen.biz/reviews/doom-review)

Design review with human(s) and agents. You feed it a design doc, get reviews from agents acting as different personas, hopefully find blind spots and address them before diving in and spending a bunch of time building. Or maybe spending a bunch of time building is fine, since it's cheaper w/ LLMs? I dunno lol.

multi-agent adversarial design review. you feed it a design doc, it assembles a panel of opinionated critic personas, and they argue about your doc for a few rounds. spits out review notes + a revised doc at the end.

This is trying to solve the syncophancy problem w/ designing w/ AI. They agree w/ too much, and are too willing to go deep on your stupid ideas. Give your designs a dose of "grumpy principal engineer" review first.

## How It Works

1. point it at a markdown design doc
2. pick a panel (preset or custom persona list)
3. a facilitator agent orients on the doc (round 0)
4. each persona speaks once per round, concurrently, streaming into the TUI
5. facilitator summarizes after each round — only the summary carries forward to conserve context
6. you can interject at any point from the TUI
7. on convergence (or round limit), it writes `review-notes.md` + `revised-doc.md` into the session dir

all session state is on disk (`sessions/session-{id}/`) so runs are inspectable, resumable in principle, and `cat`-able for debugging.

## Quickstart

```bash
pnpm install

# TUI mode (streaming, live interjection)
pnpm start docs/design-doc.md
pnpm start docs/my-doc.md -p pre-rfc
pnpm start docs/my-doc.md -p pragmatist,scope-hawk -r 3

# headless (stdout only, for CI / async runs)
pnpm review docs/my-doc.md --rounds 2 --panel pragmatist,scope-hawk

# single-agent smoke test
pnpm smoke-test

# checks
pnpm check       # oxlint + oxfmt + tsc
pnpm test        # vitest
pnpm typecheck
```

requires `opencode` installed and configured with at least one provider (Anthropic, OpenAI, etc). agents run through `@opencode-ai/sdk` so you can BYOK / swap models per persona later.

## panels

| preset         | personas                                           | default rounds |
| -------------- | -------------------------------------------------- | -------------- |
| pre-rfc        | scope-hawk, architecture-astronaut, pragmatist     | 3              |
| security-audit | security-paranoiac, grizzled-veteran, pragmatist   | 3              |
| ship-or-kill   | business-pressure, user-advocate, pragmatist       | 2              |
| greenfield     | excited-junior, architecture-astronaut, pragmatist | 3              |
| full-panel     | all 8                                              | 3              |

personas available: pragmatist, scope-hawk, security-paranoiac, user-advocate, grizzled-veteran, excited-junior, architecture-astronaut, business-pressure. each one is a markdown system prompt in `src/personas/`. facilitator is its own thing.

## stack

- Node + TypeScript (ESM), tsx for dev execution
- Effect v3 for the orchestrator (typed errors, Layer DI, fibers for concurrent agents)
- Ink 6 for the TUI
- OpenCode SDK for agent execution (multi-provider, built-in Read/Grep/Glob tools)
- filesystem for session state (no db)
- Vite Plus toolchain (vitest, oxlint, oxfmt)

the engine is UI-agnostic — the Ink TUI and the headless `run-review.ts` are both just adapters over the orchestrator. see `docs/architecture.md` for the full picture including sequence diagrams for SSE streaming, the Effect Layer DI graph, and the session directory spec.

## layout

```
src/
  cli.ts                  meow parser + Ink render
  run-review.ts           headless adapter
  smoke.ts                single-agent smoke
  engine/
    services/
      session.ts          session dir CRUD
      agent.ts            OpenCode SDK wrapper (blocking + streaming)
      opencode-server.ts  server lifecycle Layer
      orchestrator.ts     round loop, convergence, human input
      output-generator.ts review notes + revised doc
    panels.ts, prompt-assembly.ts, schema.ts, errors.ts
  ui/
    app.tsx               root Ink component + state machine
    components/           agent-card, round-view, status-bar, human-input
  personas/               persona system prompts (.md)
  panels/                 panel presets (.json)
  test/                   vitest
```

## status

early prototype. what works end-to-end:

- [x] session directory creation + manifest
- [x] panel resolution (presets + custom lists)
- [x] round 0 orientation via facilitator
- [x] concurrent persona turns with SSE streaming to TUI
- [x] facilitator round summaries (compression)
- [x] human interjection during live review
- [x] convergence detection
- [x] output generation: review-notes.md + revised-doc.md
- [x] headless mode for no-TUI runs

what's NOT built yet (things to pick up):

- **session resumption** — state's on disk but no `resume` cmd. trivially doable, just not wired
- **convergence confirmation dialog** — facilitator flags convergence but TUI doesn't prompt, just logs the score and keeps going
- **context/ population** — agents have Read/Grep/Glob via OpenCode but exploration findings don't get extracted into the shared `context/` dir yet
- **token budget enforcement** — no hard caps on per-agent-per-round output length. the persona prompts ask for <500 words, nothing enforces it
- **sidebars** — directory convention exists, no fork/merge flow
- **cost accuracy** — depends on provider reporting through OpenCode; some (e.g. gpt-5.3-codex) report $0.00 regardless
- **custom personas** — defined by dropping a markdown file in `src/personas/`, no UX for authoring them yet
- **multi-model panels** — running pragmatist on a cheap model and architecture-astronaut on a deep one would be nice. the SDK supports it, orchestrator doesn't expose it yet
- **agent-mock tests** — session service has 8 unit tests. agent + orchestrator are validated via smoke runs only; proper tests need a mock OpenCode server
- **follow-up reviews** — no memory between sessions. bringing a revised doc back for round 2 is just a fresh session rn

## design docs

- `docs/design-doc.md` — the original pitch + problem framing + open questions
- `docs/architecture.md` — current implementation record, ASCII diagrams, what's built vs not

both are fair game for the tool to review itself, which is a fun eating-your-own-dogfood move and also how this repo smoke-tests.

## non-goals (v1)

- writing the initial design doc (use other tools)
- producing structured output like Linear tickets or PRs
- real-time collaborative editing of the doc mid-session
- multi-harness participation (the filesystem protocol would enable it; prototype tests single-harness only)
- auth, multi-tenancy, deployment
