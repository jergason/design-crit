import { Effect } from 'effect'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SessionService } from './session.js'
import { AgentService } from './agent.js'
import {
  assembleAgentPrompt,
  assembleFacilitatorPrompt,
  assembleOrientationPrompt,
} from '../prompt-assembly.js'
import { generateOutput } from './output-generator.js'
import type { SessionManifest } from '../schema.js'

interface RunSessionParams {
  docPath: string
  panel: string[]
  roundLimit: number
  codebasePath?: string
  personasDir: string
  onEvent?: (event: OrchestratorEvent) => void
  /** non-blocking check for human input — returns message or undefined */
  pollHumanInput?: () => string | undefined
  /** enable verbose debug logging (SSE events, timing, session IDs) */
  debug?: boolean
}

export interface CostInfo {
  costUsd: number
  tokensIn: number
  tokensOut: number
  model: string
}

export type OrchestratorEvent =
  | { type: 'session_created'; sessionId: string }
  | { type: 'round_start'; round: number }
  | { type: 'agent_start'; round: number; persona: string }
  | { type: 'agent_delta'; round: number; persona: string; delta: string }
  | { type: 'human_interjection'; round: number; message: string }
  | { type: 'agent_complete'; round: number; persona: string; content: string; cost: CostInfo }
  | { type: 'agent_passed'; round: number; persona: string; cost: CostInfo }
  | { type: 'facilitator_summary'; round: number; summary: string; cost: CostInfo }
  | { type: 'convergence'; round: number; score: number; recommendation: string }
  | { type: 'output_start'; artifact: string }
  | { type: 'output_complete'; artifact: string; cost: number }
  | { type: 'debug'; message: string }
  | {
      type: 'session_complete'
      totalCostUsd: number
      totalTokensIn: number
      totalTokensOut: number
    }

function loadPersonaPrompt(personasDir: string, persona: string): string {
  const filePath = path.join(personasDir, `${persona}.md`)
  if (!fs.existsSync(filePath)) {
    return `You are ${persona}. Review the design document critically from your perspective.`
  }
  return fs.readFileSync(filePath, 'utf-8')
}

function parseConvergenceScore(summary: string): number {
  const match = summary.match(/\*\*Convergence:\s*(\d)\*\*/)
  if (match) return parseInt(match[1], 10)
  // fallback: look for "Convergence: N" without bold
  const fallback = summary.match(/Convergence:\s*(\d)/)
  if (fallback) return parseInt(fallback[1], 10)
  return 5 // default to "keep going" if can't parse
}

export function runSession(params: RunSessionParams) {
  const emit = params.onEvent ?? (() => {})
  const pollHuman = params.pollHumanInput ?? (() => undefined)
  const dbg = params.debug
    ? (msg: string) => emit({ type: 'debug', message: msg })
    : undefined

  return Effect.gen(function* () {
    const sessionSvc = yield* SessionService
    const agentSvc = yield* AgentService

    // create session
    const manifest = yield* sessionSvc.create({
      docPath: params.docPath,
      panel: params.panel,
      mode: 'live',
      roundLimit: params.roundLimit,
      codebasePath: params.codebasePath,
    })
    emit({ type: 'session_created', sessionId: manifest.id })

    const docContent = yield* sessionSvc.getDocContent(manifest.id)

    let totalCostUsd = 0
    let totalTokensIn = 0
    let totalTokensOut = 0

    const costFrom = (r: import('./agent.js').AgentResult): CostInfo => {
      totalCostUsd += r.costUsd
      totalTokensIn += r.tokens.input
      totalTokensOut += r.tokens.output
      return {
        costUsd: r.costUsd,
        tokensIn: r.tokens.input,
        tokensOut: r.tokens.output,
        model: r.modelId,
      }
    }

    // round 0: orientation
    emit({ type: 'round_start', round: 0 })
    emit({ type: 'agent_start', round: 0, persona: 'facilitator' })

    const facilitatorPrompt = loadPersonaPrompt(params.personasDir, 'facilitator')
    const orientationResult = yield* agentSvc.invoke({
      persona: 'facilitator',
      systemPrompt: facilitatorPrompt,
      prompt: assembleOrientationPrompt(docContent),
    })

    yield* sessionSvc.writeRoundFile(manifest.id, 0, 'facilitator.md', orientationResult.content)
    emit({
      type: 'agent_complete',
      round: 0,
      persona: 'facilitator',
      content: orientationResult.content,
      cost: costFrom(orientationResult),
    })

    let currentManifest: SessionManifest = {
      ...manifest,
      status: 'reviewing',
      currentRound: 0,
    }
    yield* sessionSvc.save(currentManifest)

    let previousSummary: string | null = orientationResult.content

    // review rounds
    for (let round = 1; round <= params.roundLimit; round++) {
      emit({ type: 'round_start', round })

      // context files (populated when agents explore codebase — empty for now)
      const contextFiles = new Map<string, string>()

      const agentResponses = new Map<string, string>()

      // check for human input before launching the round
      const humanMsg = pollHuman()
      let roundInstructions: string | undefined
      if (humanMsg) {
        emit({ type: 'human_interjection', round, message: humanMsg })
        yield* sessionSvc.writeRoundFile(manifest.id, round, 'human.md', humanMsg)
        roundInstructions = `The human has interjected with: "${humanMsg}". Take this into account.`
      }

      // invoke all personas concurrently
      const results = yield* Effect.forEach(
        params.panel,
        (persona) =>
          Effect.gen(function* () {
            emit({ type: 'agent_start', round, persona })

            const systemPrompt = loadPersonaPrompt(params.personasDir, persona)
            const prompt = assembleAgentPrompt({
              docContent,
              roundNumber: round,
              roundLimit: params.roundLimit,
              previousSummary,
              contextFiles,
              roundInstructions,
            })

            const result = yield* agentSvc.invokeStreaming(
              { persona, systemPrompt, prompt },
              (delta) => emit({ type: 'agent_delta', round, persona, delta }),
              dbg,
            )

            yield* sessionSvc.writeRoundFile(manifest.id, round, `${persona}.md`, result.content)

            const cost = costFrom(result)
            if (result.content.trim().toUpperCase() === 'PASS') {
              emit({ type: 'agent_passed', round, persona, cost })
            } else {
              emit({ type: 'agent_complete', round, persona, content: result.content, cost })
              agentResponses.set(persona, result.content)
            }
            return result
          }),
        { concurrency: 'unbounded' },
      )

      // facilitator summary
      emit({ type: 'agent_start', round, persona: 'facilitator' })

      const summaryPrompt = assembleFacilitatorPrompt({
        docContent,
        roundNumber: round,
        roundLimit: params.roundLimit,
        agentResponses,
        previousSummary,
      })

      const summaryResult = yield* agentSvc.invoke({
        persona: 'facilitator',
        systemPrompt: facilitatorPrompt,
        prompt: summaryPrompt,
      })

      yield* sessionSvc.writeRoundFile(manifest.id, round, 'summary.md', summaryResult.content)
      previousSummary = summaryResult.content

      emit({
        type: 'facilitator_summary',
        round,
        summary: summaryResult.content,
        cost: costFrom(summaryResult),
      })

      // check convergence
      const score = parseConvergenceScore(summaryResult.content)
      const shouldConverge = score <= 2 && round >= 2
      emit({
        type: 'convergence',
        round,
        score,
        recommendation: shouldConverge ? 'converge' : 'continue',
      })

      currentManifest = {
        ...currentManifest,
        currentRound: round,
        status: shouldConverge ? 'converging' : 'reviewing',
      }
      yield* sessionSvc.save(currentManifest)

      if (shouldConverge) break
    }

    // generate output artifacts
    yield* generateOutput({
      sessionId: manifest.id,
      personasDir: params.personasDir,
      onEvent: (e) => {
        if (e.type === 'generating') emit({ type: 'output_start', artifact: e.artifact })
        if (e.type === 'complete') {
          totalCostUsd += e.cost
          emit({ type: 'output_complete', artifact: e.artifact, cost: e.cost })
        }
      },
    })

    currentManifest = { ...currentManifest, status: 'complete', totalCostUsd }
    yield* sessionSvc.save(currentManifest)
    emit({ type: 'session_complete', totalCostUsd, totalTokensIn, totalTokensOut })

    return manifest.id
  })
}
