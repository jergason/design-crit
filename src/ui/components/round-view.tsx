import React from 'react'
import { Box, Text } from 'ink'
import { AgentCard } from './agent-card.js'
import type { CostInfo } from '../../engine/services/orchestrator.js'

export interface AgentState {
  persona: string
  status: 'waiting' | 'thinking' | 'complete' | 'passed'
  content?: string
  cost?: CostInfo
}

interface RoundViewProps {
  round: number
  isOrientation: boolean
  agents: AgentState[]
  summary?: string
  summaryCost?: CostInfo
}

export function RoundView({ round, isOrientation, agents, summary, summaryCost }: RoundViewProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold underline>
          Round {round}
          {isOrientation ? ' (orientation)' : ''}
        </Text>
      </Box>

      {agents.map((agent) => (
        <AgentCard key={agent.persona} {...agent} />
      ))}

      {summary && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text bold color="white">
              facilitator summary
            </Text>
            {summaryCost && (
              <Text dimColor>
                {' '}
                · ${summaryCost.costUsd.toFixed(4)} · {summaryCost.tokensIn}→{summaryCost.tokensOut}
              </Text>
            )}
          </Box>
          <Box marginLeft={2}>
            <Text wrap="wrap">{summary}</Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
