import React from 'react'
import { Box, Text } from 'ink'
import { personaColor } from '../theme.js'
import type { CostInfo } from '../../engine/services/orchestrator.js'

interface AgentCardProps {
  persona: string
  status: 'waiting' | 'thinking' | 'complete' | 'passed'
  content?: string
  cost?: CostInfo
}

export function AgentCard({ persona, status, content, cost }: AgentCardProps) {
  const color = personaColor(persona)

  const costLabel = cost
    ? ` · $${cost.costUsd.toFixed(4)} · ${cost.tokensIn}→${cost.tokensOut}`
    : ''

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={color}>
          {persona}
        </Text>
        {cost && <Text dimColor>{costLabel}</Text>}
        {status === 'thinking' && <Text color="yellow"> thinking...</Text>}
        {status === 'passed' && <Text dimColor> PASS</Text>}
      </Box>
      {status === 'complete' && content && (
        <Box marginLeft={2} marginTop={0}>
          <Text wrap="wrap">{content}</Text>
        </Box>
      )}
    </Box>
  )
}
