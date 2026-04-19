import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Effect, Exit, Layer } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionServiceLive } from '../engine/services/session.js'
import { AgentService, type AgentResult, type AgentInvokeParams } from '../engine/services/agent.js'
import { runSession, type OrchestratorEvent } from '../engine/services/orchestrator.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-crit-orch-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createTestDoc(content = '# Test Design\n\nThis is a test design document.') {
  const docPath = path.join(tmpDir, 'test-doc.md')
  fs.writeFileSync(docPath, content)
  return docPath
}

/** create a persona prompt file that the orchestrator will load */
function createPersonaPrompt(personasDir: string, persona: string) {
  fs.mkdirSync(personasDir, { recursive: true })
  fs.writeFileSync(
    path.join(personasDir, `${persona}.md`),
    `You are ${persona}. Review critically.`,
  )
}

function fakeResult(persona: string, content: string): AgentResult {
  return {
    persona,
    content,
    sessionId: `ses_fake_${persona}`,
    costUsd: 0.01,
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    modelId: 'fake-model',
    providerId: 'fake-provider',
  }
}

/**
 * Build a mock AgentService that tracks timing to verify concurrency.
 * Each invoke/invokeStreaming takes `delayMs` to simulate LLM latency.
 */
function mockAgentService(delayMs: number) {
  const invocations: { persona: string; startTime: number; endTime: number; method: string }[] = []

  const service = AgentService.of({
    invoke: (params: AgentInvokeParams) =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, delayMs)))
        const end = Date.now()
        invocations.push({ persona: params.persona, startTime: start, endTime: end, method: 'invoke' })
        // facilitator summary — include a convergence score so it converges after round 2
        return fakeResult(
          params.persona,
          `Summary for ${params.persona}\n\n**Convergence: 1**`,
        )
      }),

    invokeStreaming: (params: AgentInvokeParams, onDelta) =>
      Effect.gen(function* () {
        const start = Date.now()
        // simulate streaming deltas
        onDelta(`Review from ${params.persona}: `)
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, delayMs)))
        onDelta('looks good.')
        const end = Date.now()
        invocations.push({ persona: params.persona, startTime: start, endTime: end, method: 'invokeStreaming' })
        return fakeResult(params.persona, `Review from ${params.persona}: looks good.`)
      }),
  })

  return { service, invocations }
}

describe('orchestrator concurrency', () => {
  it('invokes panel agents concurrently within a round', async () => {
    const docPath = createTestDoc()
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const personasDir = path.join(tmpDir, 'personas')
    const panel = ['agent-a', 'agent-b', 'agent-c']
    for (const p of [...panel, 'facilitator']) createPersonaPrompt(personasDir, p)

    const delayMs = 100
    const { service, invocations } = mockAgentService(delayMs)

    const events: OrchestratorEvent[] = []
    const program = runSession({
      docPath,
      panel,
      roundLimit: 1,
      personasDir,
      onEvent: (e) => events.push(e),
    })

    const agentLayer = Layer.succeed(AgentService, service)
    const layer = SessionServiceLive(sessionsDir).pipe(
      Layer.provideMerge(agentLayer),
      Layer.provide(NodeFileSystem.layer),
    )

    const exit = await Effect.exit(Effect.provide(program, layer)).pipe(Effect.runPromise)
    expect(Exit.isSuccess(exit)).toBe(true)

    // find the streaming invocations for the 3 panel agents
    const streamInvocations = invocations.filter((i) => i.method === 'invokeStreaming')
    expect(streamInvocations).toHaveLength(3)

    // verify concurrency: all 3 should start before any finishes
    const starts = streamInvocations.map((i) => i.startTime)
    const ends = streamInvocations.map((i) => i.endTime)
    const latestStart = Math.max(...starts)
    const earliestEnd = Math.min(...ends)

    // if concurrent, all start times should be before the earliest end time
    // (with some slack for scheduling jitter)
    expect(latestStart).toBeLessThan(earliestEnd + 20)

    // total wall time should be ~1x delay, not ~3x delay
    const wallTime = Math.max(...ends) - Math.min(...starts)
    expect(wallTime).toBeLessThan(delayMs * 2) // generous margin, but less than 3x
  })

  it('waits for all agents before running facilitator summary', async () => {
    const docPath = createTestDoc()
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const personasDir = path.join(tmpDir, 'personas')
    const panel = ['agent-a', 'agent-b']
    for (const p of [...panel, 'facilitator']) createPersonaPrompt(personasDir, p)

    const { service, invocations } = mockAgentService(50)

    const program = runSession({
      docPath,
      panel,
      roundLimit: 1,
      personasDir,
    })

    const agentLayer = Layer.succeed(AgentService, service)
    const layer = SessionServiceLive(sessionsDir).pipe(
      Layer.provideMerge(agentLayer),
      Layer.provide(NodeFileSystem.layer),
    )

    const exit = await Effect.exit(Effect.provide(program, layer)).pipe(Effect.runPromise)
    expect(Exit.isSuccess(exit)).toBe(true)

    // facilitator (invoke) should start AFTER all streaming agents finish
    const streamEnds = invocations
      .filter((i) => i.method === 'invokeStreaming')
      .map((i) => i.endTime)
    const facilitatorStarts = invocations
      .filter((i) => i.persona === 'facilitator' && i.method === 'invoke')

    // exclude the orientation facilitator (round 0) — get the summary one
    // the summary facilitator should be the last invoke call
    const summaryFacilitator = facilitatorStarts[facilitatorStarts.length - 1]
    expect(summaryFacilitator).toBeDefined()
    expect(summaryFacilitator.startTime).toBeGreaterThanOrEqual(Math.max(...streamEnds) - 5)
  })

  it('collects all agent responses and emits events for each', async () => {
    const docPath = createTestDoc()
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const personasDir = path.join(tmpDir, 'personas')
    const panel = ['alpha', 'beta']
    for (const p of [...panel, 'facilitator']) createPersonaPrompt(personasDir, p)

    const { service } = mockAgentService(20)

    const events: OrchestratorEvent[] = []
    const program = runSession({
      docPath,
      panel,
      roundLimit: 1,
      personasDir,
      onEvent: (e) => events.push(e),
    })

    const agentLayer = Layer.succeed(AgentService, service)
    const layer = SessionServiceLive(sessionsDir).pipe(
      Layer.provideMerge(agentLayer),
      Layer.provide(NodeFileSystem.layer),
    )

    const exit = await Effect.exit(Effect.provide(program, layer)).pipe(Effect.runPromise)
    expect(Exit.isSuccess(exit)).toBe(true)

    // verify events for round 1 panel agents (exclude facilitator)
    const round1Starts = events.filter(
      (e) =>
        e.type === 'agent_start' &&
        'round' in e &&
        e.round === 1 &&
        'persona' in e &&
        e.persona !== 'facilitator',
    )
    const round1Completes = events.filter(
      (e) => e.type === 'agent_complete' && 'round' in e && e.round === 1,
    )
    const round1Deltas = events.filter(
      (e) => e.type === 'agent_delta' && 'round' in e && e.round === 1,
    )

    expect(round1Starts).toHaveLength(2) // alpha + beta
    expect(round1Completes).toHaveLength(2)
    expect(round1Deltas.length).toBeGreaterThan(0)

    // verify session_complete at the end
    const complete = events.find((e) => e.type === 'session_complete')
    expect(complete).toBeDefined()
  })
})
