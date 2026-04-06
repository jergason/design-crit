import React from 'react'
import { Box, Text } from 'ink'

interface StatusBarProps {
  sessionId?: string
  currentRound: number
  roundLimit: number
  totalCost: number
  status: string
}

export function StatusBar({
  sessionId,
  currentRound,
  roundLimit,
  totalCost,
  status,
}: StatusBarProps) {
  return (
    <Box marginBottom={1} gap={2}>
      {sessionId && <Text dimColor>{sessionId}</Text>}
      <Text>
        round <Text bold>{currentRound}</Text>/{roundLimit}
      </Text>
      <Text>
        cost{' '}
        <Text bold color={totalCost > 1 ? 'red' : 'green'}>
          ${totalCost.toFixed(4)}
        </Text>
      </Text>
      <Text>
        status <Text bold>{status}</Text>
      </Text>
    </Box>
  )
}
