import React, { useState, useEffect, useCallback } from 'react'
import { Box, Text, useApp } from 'ink'
import { Effect, Layer } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { RoundView, type AgentState } from './components/round-view.js'
import { StatusBar } from './components/status-bar.js'
import { resolvePanel } from '../engine/panels.js'
import { SessionServiceLive } from '../engine/services/session.js'
import { AgentServiceLive } from '../engine/services/agent.js'
import { OpenCodeServerLive } from '../engine/services/opencode-server.js'
import {
  runSession,
  type OrchestratorEvent,
  type CostInfo,
} from '../engine/services/orchestrator.js'

interface AppProps {
  docPath?: string
  panel?: string
  rounds: number
  codebasePath?: string
}

interface RoundData {
  round: number
  agents: AgentState[]
  summary?: string
  summaryCost?: CostInfo
}

export function App({ docPath, panel, rounds, codebasePath }: AppProps) {
  const { exit } = useApp()
  const [sessionId, setSessionId] = useState<string>()
  const [status, setStatus] = useState('setup')
  const [currentRound, setCurrentRound] = useState(0)
  const [totalCost, setTotalCost] = useState(0)
  const [roundsData, setRoundsData] = useState<RoundData[]>([])
  const [error, setError] = useState<string>()
  const [finalStats, setFinalStats] = useState<{
    totalCostUsd: number
    totalTokensIn: number
    totalTokensOut: number
  }>()

  const resolved = resolvePanel(panel)
  const panelList = resolved.personas
  const effectiveRounds = resolved.roundLimit ?? rounds

  const handleEvent = useCallback(
    (event: OrchestratorEvent) => {
      switch (event.type) {
        case 'session_created':
          setSessionId(event.sessionId)
          setStatus('reviewing')
          break

        case 'round_start':
          setCurrentRound(event.round)
          setRoundsData((prev) => [
            ...prev,
            {
              round: event.round,
              agents:
                event.round === 0
                  ? [{ persona: 'facilitator', status: 'waiting' }]
                  : panelList.map((p) => ({ persona: p, status: 'waiting' as const })),
            },
          ])
          break

        case 'agent_start':
          setRoundsData((prev) =>
            prev.map((rd) =>
              rd.round === event.round
                ? {
                    ...rd,
                    agents: rd.agents.map((a) =>
                      a.persona === event.persona ? { ...a, status: 'thinking' as const } : a,
                    ),
                  }
                : rd,
            ),
          )
          break

        case 'agent_complete':
          setTotalCost((prev) => prev + event.cost.costUsd)
          setRoundsData((prev) =>
            prev.map((rd) =>
              rd.round === event.round
                ? {
                    ...rd,
                    agents: rd.agents.map((a) =>
                      a.persona === event.persona
                        ? {
                            ...a,
                            status: 'complete' as const,
                            content: event.content,
                            cost: event.cost,
                          }
                        : a,
                    ),
                  }
                : rd,
            ),
          )
          break

        case 'agent_passed':
          setTotalCost((prev) => prev + event.cost.costUsd)
          setRoundsData((prev) =>
            prev.map((rd) =>
              rd.round === event.round
                ? {
                    ...rd,
                    agents: rd.agents.map((a) =>
                      a.persona === event.persona
                        ? { ...a, status: 'passed' as const, cost: event.cost }
                        : a,
                    ),
                  }
                : rd,
            ),
          )
          break

        case 'facilitator_summary':
          setTotalCost((prev) => prev + event.cost.costUsd)
          setRoundsData((prev) =>
            prev.map((rd) =>
              rd.round === event.round
                ? { ...rd, summary: event.summary, summaryCost: event.cost }
                : rd,
            ),
          )
          break

        case 'convergence':
          if (event.recommendation === 'converge') {
            setStatus('converging')
          }
          break

        case 'output_start':
          setStatus(`generating ${event.artifact}`)
          break

        case 'output_complete':
          setTotalCost((prev) => prev + event.cost)
          break

        case 'session_complete':
          setStatus('complete')
          setFinalStats({
            totalCostUsd: event.totalCostUsd,
            totalTokensIn: event.totalTokensIn,
            totalTokensOut: event.totalTokensOut,
          })
          break
      }
    },
    [panelList],
  )

  useEffect(() => {
    if (!docPath) return

    const resolvedDoc = path.resolve(docPath)
    if (!fs.existsSync(resolvedDoc)) {
      setError(`doc not found: ${resolvedDoc}`)
      return
    }

    const sessionsDir = path.join(process.cwd(), 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const personasDir = path.join(import.meta.dirname, '..', 'personas')

    const program = runSession({
      docPath: resolvedDoc,
      panel: panelList,
      roundLimit: effectiveRounds,
      codebasePath,
      personasDir,
      onEvent: handleEvent,
    })

    const layer = SessionServiceLive(sessionsDir).pipe(
      Layer.provideMerge(AgentServiceLive),
      Layer.provideMerge(OpenCodeServerLive),
      Layer.provide(NodeFileSystem.layer),
    )

    Effect.runPromise(Effect.provide(program, layer))
      .then(() => {
        setTimeout(() => exit(), 1000)
      })
      .catch((err) => {
        setError(String(err))
        setTimeout(() => exit(), 1000)
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!docPath) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">
          design-crit
        </Text>
        <Text>
          usage: design-crit {'<'}doc.md{'>'} [--panel persona1,persona2] [--rounds N]
        </Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box padding={1}>
        <Text color="red">error: {error}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          design-crit
        </Text>
        <Text dimColor> — reviewing {path.basename(docPath)}</Text>
      </Box>

      <StatusBar
        sessionId={sessionId}
        currentRound={currentRound}
        roundLimit={effectiveRounds}
        totalCost={totalCost}
        status={status}
      />

      {roundsData.map((rd) => (
        <RoundView
          key={rd.round}
          round={rd.round}
          isOrientation={rd.round === 0}
          agents={rd.agents}
          summary={rd.summary}
          summaryCost={rd.summaryCost}
        />
      ))}

      {finalStats && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>review complete</Text>
          <Text>
            total cost:{' '}
            <Text bold color="green">
              ${finalStats.totalCostUsd.toFixed(4)}
            </Text>{' '}
            · {finalStats.totalTokensIn} in / {finalStats.totalTokensOut} out
          </Text>
        </Box>
      )}
    </Box>
  )
}
