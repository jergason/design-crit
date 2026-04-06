import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import TextInput from 'ink-text-input'

interface HumanInputProps {
  enabled: boolean
  onSubmit: (message: string) => void
}

export function HumanInput({ enabled, onSubmit }: HumanInputProps) {
  const [value, setValue] = useState('')

  const handleSubmit = (input: string) => {
    if (!input.trim()) return
    onSubmit(input.trim())
    setValue('')
  }

  useInput((input, key) => {
    if (key.escape) {
      setValue('')
    }
  })

  if (!enabled) return null

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor="gray" paddingX={1}>
      <Text dimColor>type to interject (enter to send, esc to clear)</Text>
      <Box>
        <Text color="cyan">{' > '}</Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}
