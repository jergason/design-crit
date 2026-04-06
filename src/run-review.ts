#!/usr/bin/env tsx
/**
 * Run a full multi-agent design review from the command line.
 * Usage: node --experimental-modules src/run-review.ts <doc.md> [--rounds N] [--panel persona1,persona2]
 */
import { Effect, Layer } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { SessionServiceLive } from './engine/services/session.js'
import { AgentServiceLive } from './engine/services/agent.js'
import { OpenCodeServerLive } from './engine/services/opencode-server.js'
import { runSession } from './engine/services/orchestrator.js'

// parse args
const args = process.argv.slice(2)
const docPath = args.find((a) => !a.startsWith('--'))
if (!docPath) {
  console.error('usage: run-review <doc.md> [--rounds N] [--panel persona1,persona2]')
  process.exit(1)
}

const roundsFlag = args.indexOf('--rounds')
const rounds = roundsFlag >= 0 ? parseInt(args[roundsFlag + 1], 10) : 2

const panelFlag = args.indexOf('--panel')
const panel =
  panelFlag >= 0
    ? args[panelFlag + 1].split(',')
    : ['pragmatist', 'scope-hawk', 'security-paranoiac']

if (!fs.existsSync(docPath)) {
  console.error(`doc not found: ${docPath}`)
  process.exit(1)
}

const sessionsDir = path.join(process.cwd(), 'sessions')
fs.mkdirSync(sessionsDir, { recursive: true })

const personasDir = path.join(import.meta.dirname, 'personas')

console.log(`\n  design-crit review`)
console.log(`  doc: ${docPath}`)
console.log(`  panel: ${panel.join(', ')}`)
console.log(`  rounds: ${rounds}`)
console.log()

const program = runSession({
  docPath: path.resolve(docPath),
  panel,
  roundLimit: rounds,
  personasDir,
  onEvent: (event) => {
    switch (event.type) {
      case 'session_created':
        console.log(`  session: ${event.sessionId}\n`)
        break
      case 'round_start':
        console.log(`${'='.repeat(60)}`)
        console.log(`  ROUND ${event.round}${event.round === 0 ? ' (orientation)' : ''}`)
        console.log(`${'='.repeat(60)}\n`)
        break
      case 'agent_start':
        process.stdout.write(`  --- ${event.persona} ---\n`)
        break
      case 'agent_delta':
        process.stdout.write(event.delta)
        break
      case 'agent_complete':
        console.log(
          `\n  [${event.cost.model} · $${event.cost.costUsd.toFixed(4)} · ${event.cost.tokensIn}→${event.cost.tokensOut} tokens]\n`,
        )
        break
      case 'agent_passed':
        console.log(
          `  --- ${event.persona} [${event.cost.model} · $${event.cost.costUsd.toFixed(4)}] ---\n  PASS\n`,
        )
        break
      case 'facilitator_summary':
        console.log(
          `  --- facilitator [${event.cost.model} · $${event.cost.costUsd.toFixed(4)} · ${event.cost.tokensIn}→${event.cost.tokensOut} tokens] ---\n`,
        )
        console.log(event.summary)
        console.log()
        break
      case 'convergence':
        console.log(`  convergence score: ${event.score}/5 — ${event.recommendation}\n`)
        break
      case 'output_start':
        console.log(`  generating ${event.artifact}...`)
        break
      case 'output_complete':
        console.log(`  ${event.artifact} done ($${event.cost.toFixed(4)})\n`)
        break
      case 'session_complete':
        console.log(`${'='.repeat(60)}`)
        console.log(`  REVIEW COMPLETE`)
        console.log(`  total cost: $${event.totalCostUsd.toFixed(4)}`)
        console.log(`  total tokens: ${event.totalTokensIn} in / ${event.totalTokensOut} out`)
        console.log(`${'='.repeat(60)}\n`)
        break
    }
  },
})

const layer = SessionServiceLive(sessionsDir).pipe(
  Layer.provideMerge(AgentServiceLive),
  Layer.provideMerge(OpenCodeServerLive),
  Layer.provide(NodeFileSystem.layer),
)

Effect.runPromise(Effect.provide(program, layer)).catch((err) => {
  console.error('review failed:', err)
  process.exit(1)
})
