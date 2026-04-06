# Design Crit: Architecture & Implementation Record

## What This Is

A multi-agent adversarial design review tool. You give it a design doc, pick a panel of critic personas, and it runs a structured multi-round review where each persona argues from their critical lens. A facilitator agent manages the discussion, summarizes rounds, and detects convergence. At the end it produces review notes and a revised doc.

## Tech Stack

| Layer           | Choice                                          |
| --------------- | ----------------------------------------------- |
| Runtime         | Node.js + TypeScript (ESM)                      |
| TUI             | Ink 6 (React for terminals)                     |
| Engine          | Effect v3 (typed errors, DI via Layers, fibers) |
| Agent execution | OpenCode SDK (`@opencode-ai/sdk`)               |
| State           | Filesystem (session directories)                |
| Dev runner      | tsx (zero-config TS execution)                  |
| Toolchain       | Vite Plus (vitest, oxlint, oxfmt)               |

### Why These Choices

**OpenCode SDK** over Anthropic SDK or Claude Agent SDK: multi-provider support (BYOK), built-in codebase tools (Read, Grep, Glob), and the `createOpencode()` function handles server lifecycle. tradeoff is it spawns a server process, but for 3-5 concurrent agents that's fine.

**Effect** over vanilla async/await: the orchestrator juggles concurrent agent calls, typed errors (session not found, agent timeout, budget exceeded), and DI (swap real OpenCode for mocks in tests). Effect's `Layer` system and tagged errors make this natural rather than painful.

**Ink** over OpenTUI: OpenTUI requires Bun. We wanted Node.

**Filesystem as state**: session directories are inspectable (`cat rounds/round-01/pragmatist.md`), resumable (restart orchestrator, it reads session.json and picks up), and debuggable. the tradeoff vs in-memory is I/O overhead, but for a tool that waits on LLM calls, disk writes are noise.

## Architecture

```
src/
  cli.ts                           entry point, meow arg parsing, Ink render
  run-review.ts                    headless CLI runner (no TUI, stdout only)
  smoke.ts                         minimal single-agent smoke test

  engine/
    schema.ts                      Effect Schema types (SessionManifest, etc.)
    errors.ts                      tagged errors (SessionNotFound, AgentInvokeError, etc.)
    panels.ts                      panel preset loading + resolution
    prompt-assembly.ts             compose prompts from session state

    services/
      session.ts                   SessionService — CRUD for session directories
      agent.ts                     AgentService — wraps OpenCode SDK sessions
      opencode-server.ts           OpenCodeServer Layer — server lifecycle
      orchestrator.ts              round loop, convergence, human input, output
      output-generator.ts          review notes + revised doc generation

  ui/
    app.tsx                        root Ink component, state machine, event handling
    theme.ts                       persona color assignment
    components/
      agent-card.tsx               single agent's streaming output display
      round-view.tsx               round container with agents + summary
      status-bar.tsx               session/round/cost display
      human-input.tsx              text input for interjections

  personas/                        markdown system prompts (one per persona)
  panels/                          JSON panel presets
  test/
    session.test.ts                session service unit tests
```

### Data Flow

```
CLI args → App component → runSession(params)
                              ↓
                        OpenCode server starts
                              ↓
                        Session directory created
                              ↓
                    ┌── Round 0: Facilitator orientation
                    │
                    ├── Round 1..N:
                    │     for each persona:
                    │       1. check human input queue
                    │       2. assemble prompt (doc + summary + context)
                    │       3. invokeStreaming → SSE text deltas → TUI
                    │       4. write response to disk
                    │     facilitator summarizes round
                    │     check convergence score
                    │
                    ├── Output generation:
                    │     facilitator produces review-notes.md
                    │     facilitator produces revised-doc.md
                    │
                    └── Session complete
```

### Session Directory Structure

```
sessions/session-{id}/
  session.json           manifest (id, status, panel, round, cost)
  doc.md                 copy of the design doc
  context/               shared exploration findings (future)
  rounds/
    round-00/
      facilitator.md     orientation summary
    round-01/
      pragmatist.md      persona review
      scope-hawk.md      persona review
      human.md           human interjection (if any)
      summary.md         facilitator round summary
    round-02/
      ...
  output/
    review-notes.md      structured review summary
    revised-doc.md       doc with accepted feedback incorporated
  sidebars/              (future)
```

### Effect Service Graph

```
OrchestratorService (runSession)
  ├── SessionService          disk I/O via @effect/platform FileSystem
  │     └── NodeFileSystem    provided via Layer
  ├── AgentService            wraps OpenCode SDK client
  │     └── OpenCodeServer    server lifecycle via Layer.scoped + acquireRelease
  └── FacilitatorService      (inline in orchestrator, uses AgentService)
```

The `SessionServiceLive(dir)` layer captures `FileSystem` via `Layer.effect`, so all methods return bare `Effect<A, E>` with no requirements. Tests provide `NodeFileSystem.layer`, and the service uses atomic writes (tmp + rename) for session.json.

### Streaming

Two paths for agent invocation:

**`invoke(params)`** — blocking. Sends prompt via `client.session.prompt()`, waits for full response. Used for facilitator summaries and output generation.

**`invokeStreaming(params, onDelta)`** — streaming. Uses `client.session.promptAsync()` (fire-and-forget) + `client.event.subscribe()` (SSE). Watches for `message.part.updated` events with text deltas, calls `onDelta` for each chunk. Resolves when `session.idle` event fires. Used for review personas so the TUI shows text as it's generated.

### Human Interjection

The orchestrator accepts a `pollHumanInput` callback. Between each agent turn, it calls this function (non-blocking). If a message is queued:

1. It's written to `rounds/round-NN/human.md`
2. It's injected into the next agent's prompt as round instructions
3. The TUI displays it inline as a "you" card in the round view

The TUI provides a text input at the bottom that pushes messages to a ref-based queue. The orchestrator polls this queue synchronously between turns.

## Personas

8 critic archetypes + 1 facilitator. Each is a markdown file with: role definition, arguing style, watch-fors, what they champion, and rules (ground in specifics, say PASS if nothing new, stay under 500 words).

| Persona                | Lens                                             |
| ---------------------- | ------------------------------------------------ |
| pragmatist             | shipping risk, over-engineering                  |
| scope-hawk             | feature creep, scope control                     |
| security-paranoiac     | attack vectors, trust boundaries                 |
| user-advocate          | UX, user journeys, onboarding                    |
| grizzled-veteran       | historical patterns, operational reality         |
| excited-junior         | clarity gaps, "what if" questions                |
| architecture-astronaut | abstractions, interfaces, composability          |
| business-pressure      | time-to-value, validation, speed                 |
| facilitator            | summarization, convergence detection, neutrality |

## Panel Presets

| Preset         | Personas                                           | Default Rounds |
| -------------- | -------------------------------------------------- | -------------- |
| pre-rfc        | scope-hawk, architecture-astronaut, pragmatist     | 3              |
| security-audit | security-paranoiac, grizzled-veteran, pragmatist   | 3              |
| ship-or-kill   | business-pressure, user-advocate, pragmatist       | 2              |
| greenfield     | excited-junior, architecture-astronaut, pragmatist | 3              |
| full-panel     | all 8                                              | 3              |

## How to Run

```bash
# install
pnpm install

# TUI mode (streaming, human interjection)
pnpm start docs/design-doc.md
pnpm start docs/design-doc.md -p pre-rfc
pnpm start docs/design-doc.md -p pragmatist,scope-hawk -r 3

# headless mode (stdout, no TUI)
pnpm review docs/design-doc.md --rounds 2 --panel pragmatist,scope-hawk

# smoke test (single agent, quick)
pnpm smoke-test

# checks
pnpm check       # oxlint + oxfmt + tsc
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit only
```

Requires `opencode` installed and configured with at least one provider (Anthropic, OpenAI, etc.).

## What's Not Built Yet

- **Session resumption**: session state is on disk but there's no `resume` command yet
- **Convergence dialog**: facilitator recommends convergence, but the TUI doesn't prompt the user to confirm — it just logs the score and continues
- **Context file population**: agents have codebase tools via OpenCode but exploration findings aren't extracted to `context/` yet
- **Token budget enforcement**: no hard caps on agent output length
- **Sidebar support**: the directory structure exists but there's no sidebar fork/merge flow
- **Cost accuracy**: depends on what the provider reports through OpenCode — some providers (e.g., gpt-5.3-codex) report $0.00

## Testing

Session service has 8 unit tests covering create, load, roundtrip, corruption detection, save, round files, context files, and getAllRoundResponses. All use temp directories and real filesystem. Agent and orchestrator tests would need a mock OpenCode server — deferred for now, validated via the smoke test and full review runs.
