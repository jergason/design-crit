const PERSONA_COLORS = [
  'cyan',
  'yellow',
  'magenta',
  'green',
  'blue',
  'red',
  'white',
  'gray',
] as const

// deterministic color for a persona name
export function personaColor(persona: string): string {
  let hash = 0
  for (let i = 0; i < persona.length; i++) {
    hash = (hash * 31 + persona.charCodeAt(i)) | 0
  }
  return PERSONA_COLORS[Math.abs(hash) % PERSONA_COLORS.length]
}
