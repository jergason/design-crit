# Design Crit: Multi-Agent Adversarial Design Review

## Problem

Engineers working with AI assistants face a new failure mode: the AI agrees with everything. You pair with an agent, you go deep on an approach, and nobody pushes back. By the time you bring it to a human review, you've invested hours in a direction that a 5-minute challenge from a different perspective would have killed.

Human design reviews are great but expensive — getting 5 senior engineers in a room costs real money and calendar tetris. And each human can only hold one mental model at a time.

We want the rigor of a multi-perspective design review, available on-demand, with agents that are _constitutionally committed_ to their critical lens and won't politely defer.

## Proposed Solution

A tool ("Design Crit") that orchestrates a structured, multi-agent adversarial review of a design document. An engineer submits a design doc, selects a panel of critic personas, and the tool runs a facilitated multi-round discussion that produces a revised design doc and review notes.

### Core Concepts

**Session**: A single review of a single design doc. Has a mode (live or async), a round limit, and a panel of personas.

**Persona**: A named critic archetype with a pithy one-line identity and a system prompt that defines their lens, priorities, and arguing style. Examples:

- **The Pragmatist** — "will this actually ship, or are we building a cathedral?"
- **The Scope Hawk** — "fights feature creep like it insulted their mother"
- **The Security Paranoiac** — "sees attack vectors in the gaps between your sentences"
- **The User Advocate** — "keeps dragging the conversation back to what humans actually want"
- **The Grizzled Veteran** — "has mass graves of microservices behind every gaze"
- **The Excited Junior** — "genuinely enthusiastic about new tech, asks lots of 'what if' questions"
- **The Architecture Astronaut** — "never met an abstraction layer they didn't like"
- **The Business Pressure** — "users are waiting. what's the fastest path to their hands?"

**Panel**: A set of personas assembled for a session. Can be a preset or custom-assembled.

**Facilitator**: A special agent that manages the discussion flow — summarizes rounds, tracks decisions, notices circular arguments, calls for convergence, and defers to humans when they speak.

**Round**: One turn of the discussion. Each agent speaks once per round (or passes). Humans can interject at any point, which pauses the current round.

**Sidebar**: A forked sub-conversation where the human can explore a topic with one or more agents without derailing the main thread. Findings from sidebars can be summarized back into the main session.

**Shared Context**: A pool of knowledge that all agents can access — includes the design doc, codebase exploration findings, and any artifacts surfaced during the session. When one agent discovers something (e.g., "the auth module already handles this case"), it enters the shared context for all agents to reference. Humans can update the shared context also.

### Session Flow

```
1. SETUP
   Human provides: design doc (markdown), optional codebase path
   Human selects: panel preset or custom personas, mode (live/async), round limit

2. ORIENTATION (Round 0)
   Facilitator reads the doc, produces a brief summary and key questions.
   If context is unclear, facilitator may suggest fleshing out specific sections
   before proceeding.
   Agents receive: doc + shared context + their persona prompt.

3. REVIEW ROUNDS (Rounds 1..N)
   Each round:
   a. Each agent speaks once (or passes if nothing new to add)
   b. Agents can reference, rebut, or build on other agents' points
   c. Agents can request codebase exploration — findings go to shared context
   d. Facilitator summarizes the round, notes decisions/open questions
   e. Human can interject at any point (pauses round, floor goes to human)
   f. Human can open a sidebar (fork conversation, explore, return findings)

4. CONVERGENCE
   Facilitator detects consensus or diminishing returns, or round limit hit.
   Facilitator proposes wrap-up: "Here's where we are. Continue or summarize?"
   Human decides.

5. OUTPUT
   Facilitator produces:
   - Revised design doc (incorporating accepted feedback)
   - Review notes (key discussion points, decisions, dissenting opinions, open questions)
   - Optional: action items / todos (unstructured for v1)
```

### Modes

**Live mode**: Human is present throughout. Rounds proceed with human able to interject, steer, sidebar. Agents may be paced (one-at-a-time, or all-at-once per round — TBD, needs experimentation).

**Async mode**: Human kicks off the session and walks away. Agents complete all rounds autonomously. Facilitator manages the discussion. Human reviews the output afterward and can optionally resume for additional rounds.

### Pacing and Human Priority

How humans interact with a live multi-agent chat is an open UX problem. Options to explore:

- **Rounds-based**: Agents take turns in structured rounds, human interjects between rounds. Simplest to implement, most controlled.
- **Interrupt model**: Human types and all agents pause, facilitator yields floor. More natural but harder to implement.
- **Speed dial**: Human controls pace — fast (agents go), slow (one at a time, confirm to continue), pause.

Starting with rounds-based for the prototype.

### Cost and Noise Control

Multiple agents having multi-round discussions is expensive and can produce walls of text. Mitigations:

- **Facilitator as compressor**: After each round, facilitator summarizes. Agents argue against the summary, not the full transcript. Only the summary carries forward to the next round's context. This might or might not work, need to experiment.
- **Relevance gating**: Agents can pass on a round. No forced output.
- **Token budgets**: Cap per-agent per-round output length. Forces concision.
- **Early termination**: Facilitator proposes ending early if consensus reached or diminishing returns detected.
- **Lazy codebase exploration**: Don't front-load full repo analysis. Agents request specific explorations as needed, findings shared. (Is this just tool calls to claude code or something?)

### Codebase and External Context

Agents can:

- Explore the codebase to find existing patterns, relevant code, prior art
- Reference data structures, logs, analytics if available
- Ground their arguments in what actually exists, not just what could exist

All findings go into the shared context pool so exploration isn't duplicated.

## Architecture

### Design Philosophy: Filesystem as Protocol

Inspired by the unix "everything is a file" principle and emerging patterns in multi-agent coordination (see: [Piskala 2026, "Files Are All You Need"](https://arxiv.org/html/2601.11672v1)), the session state lives entirely on the filesystem. The filesystem _is_ the coordination layer.

This buys us several things:

- **Zero-integration multi-harness support**: Any agent that can read and write files can participate. Claude Code, Codex, OpenCode, a human with a text editor — they all speak filesystem natively. No adapters, no SDKs, no protocol negotiation.
- **Auditability for free**: The session transcript is just files. You can `git diff` between rounds, `cat` the shared context, `grep` the transcript. Debugging is reading.
- **Trivial persistence and resumption**: Pause = stop writing. Resume = start again. State is right there on disk.
- **Simplicity**: The participant interface is "read these files, write this file." That's it.

The tradeoff is that filesystems are less natural for real-time coordination (turn enforcement, human interrupts, token budget rejection). A thin orchestrator process manages those concerns while the filesystem remains the source of truth.

### High-Level Design

```
┌──────────────────────────────────────────────────────┐
│                   Session Directory                   │
│                                                      │
│  session.json        ← state, config, current round  │
│  doc.md              ← the design doc under review   │
│  context/            ← shared findings, explorations │
│  rounds/                                             │
│    round-00/         ← orientation                   │
│      facilitator.md                                  │
│    round-01/                                         │
│      pragmatist.md                                   │
│      scope-hawk.md                                   │
│      security.md                                     │
│      summary.md      ← facilitator's round summary   │
│    round-02/                                         │
│      ...                                             │
│  sidebars/           ← forked sub-conversations      │
│    sidebar-01/                                       │
│      ...                                             │
│  output/                                             │
│    revised-doc.md                                    │
│    review-notes.md                                   │
└──────────────────────────────────────────────────────┘
              ▲                          ▲
              │ reads/writes             │ reads/writes
              │                          │
     ┌────────┴─────────┐      ┌────────┴────────┐
     │   Orchestrator   │      │     Agents      │
     │   (thin process) │      │  (any harness)  │
     └──────────────────┘      └─────────────────┘
```

### The Orchestrator

A thin process (not a full server) that manages coordination on top of the filesystem:

- Reads `session.json` to determine current state
- Signals agents when it's their turn (writes a turn marker file, or invokes them directly)
- Enforces round limits and token budgets (validates agent output before accepting it)
- Runs the facilitator agent at the end of each round to produce `summary.md`
- Watches for human input (a human writes to a known location, orchestrator picks it up)
- Manages round transitions (creates next round directory, updates `session.json`)
- Triggers output generation when the session ends

The orchestrator is intentionally thin. It doesn't hold state in memory — it reads and writes the session directory. If it crashes, you can restart it and it picks up where it left off.

### Session Directory Spec

**`session.json`** — the session manifest:

```json
{
  "id": "session-abc123",
  "doc": "doc.md",
  "codebase": "/path/to/repo",
  "mode": "live",
  "round_limit": 5,
  "current_round": 2,
  "status": "in_progress",
  "panel": ["pragmatist", "scope-hawk", "security-paranoiac"],
  "facilitator": "default",
  "token_budget_per_agent_per_round": 1000,
  "created_at": "2026-04-05T10:00:00Z"
}
```

**`context/`** — shared knowledge pool. Any agent can write findings here (e.g., `context/auth-module-analysis.md`). All agents read this directory before each round. Humans can drop files here too.

**`rounds/round-NN/`** — one directory per round. Each agent writes one file named after their persona. The facilitator writes `summary.md` after all agents have spoken. The summary is what carries forward — agents in the next round read the summary, not the full individual responses.

**`sidebars/`** — forked conversations. Each sidebar is a mini-session with its own round structure. A `findings.md` file gets written when the sidebar concludes, which the orchestrator can inject into the shared context.

### Participant Interface

An agent participant needs to:

1. **Read**: `session.json`, `doc.md`, `context/*`, latest `rounds/round-NN/summary.md`
2. **Write**: `rounds/round-NN/{persona-name}.md` with their response (or a pass marker)

That's the whole interface. If you can read and write files, you can be a participant. The orchestrator handles everything else (turn order, validation, round transitions).

For the prototype, the orchestrator invokes agents directly (shelling out to claude or calling an API). For multi-harness mode, agents could poll the session directory for turn markers, or the orchestrator could invoke them via whatever mechanism they support.

### Separation of Concerns

```
engine/         ← orchestrator logic: round management, validation, turn order
personas/       ← persona definitions (markdown files with system prompts)
panels/         ← panel presets (lists of personas + config)
adapters/       ← UI layer: CLI reads/writes the session dir, renders to terminal
```

The engine operates entirely on the session directory. The CLI adapter is just a nice way to set up a session, display progress, and handle human input — it reads the same files any agent would.

### Multi-Harness Support

Falls out naturally from the filesystem protocol. To add a new harness:

1. Point it at the session directory
2. Give it a persona system prompt
3. Have it watch for its turn (or have the orchestrator invoke it)
4. It reads context, writes its response

No adapter code needed. The filesystem _is_ the adapter.

## Panel Presets

**Pre-RFC Review** — scope hawk, architecture astronaut, pragmatist
_For: early-stage proposals that need shape before wider review_

**Security Audit** — security paranoiac, existing patterns, grizzled veteran
_For: reviewing designs that touch auth, data, APIs, or trust boundaries_

**Ship-or-Kill** — business pressure, user advocate, pragmatist
_For: deciding whether to invest further or cut scope aggressively_

**Greenfield Exploration** — excited junior, architecture astronaut, devil's advocate
_For: exploring new problem spaces where wild ideas are welcome_

**Full Panel** — all personas
_For: comprehensive review when cost isn't a concern_

## Output Spec

### Revised Design Doc

A new markdown document that incorporates accepted feedback from the session. Preserves the original structure but updates sections based on decisions made during the review. Does not silently drop content — changes are motivated by the discussion.

### Review Notes

A structured summary:

- **Session metadata**: panel used, rounds completed, mode, duration
- **Key discussion points**: the main topics debated, with brief summaries of positions taken
- **Decisions**: what was agreed on, with rationale
- **Dissenting opinions**: where consensus was NOT reached, and why
- **Open questions**: things that need more investigation or input
- **Action items**: (optional) concrete next steps surfaced during the review

## Open Questions

- **Agent-to-agent dynamics**: Should agents form alliances or build on each other's arguments more explicitly? Could lead to emergent coalition behavior. Mark for exploration.
- **Orchestrator scope**: The orchestrator is a server that uses the filesystem as its database. The key constraint is that it should remain stateless — all session state lives on disk, so it can crash and restart without losing anything. But it still needs to do real work: validate outputs, enforce budgets, manage turns, handle human input. How much logic lives in the orchestrator vs. being encoded in the filesystem conventions themselves?
- **Pacing UX in live mode**: Rounds-based is the starting point, but interrupt and speed-dial models may feel more natural. Needs user testing.
- **Persona creation**: Users should be able to define custom personas. What's the right UX for this? Just a text prompt? A structured template? TODO: explore this later.
- **Context window management**: Long sessions with codebase exploration could blow context limits. The facilitator's compression role is critical but hard to get right.
- **Multi-model panels**: Running different personas on different models (e.g., the pragmatist on a fast/cheap model, the architecture astronaut on a deep/expensive one) could optimize cost/quality. Could you bring your own models? OpenCode in one, codex in another, etc?
- **Session persistence and resumption**: Can you pause a session and come back tomorrow? What state needs to be serialized?
- **Feedback loops**: After the engineer implements the revised design, can they bring it back for a follow-up review? Does the tool remember what it said last time?

## Non-Goals (v1)

- Writing the initial design doc (use other tools for this)
- Producing structured output like Linear tickets or PRs (thinking tool only for now)
- Real-time collaborative editing of the design doc during the session
- Multi-harness participation (filesystem protocol enables it, but prototype tests with single harness only)
- Authentication, multi-tenancy, or any deployment concerns
