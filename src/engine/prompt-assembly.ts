interface AssembleAgentPromptParams {
  docContent: string
  roundNumber: number
  roundLimit: number
  previousSummary: string | null
  contextFiles: Map<string, string>
  roundInstructions?: string
}

interface AssembleFacilitatorPromptParams {
  docContent: string
  roundNumber: number
  roundLimit: number
  agentResponses: Map<string, string>
  previousSummary: string | null
}

export function assembleAgentPrompt(params: AssembleAgentPromptParams): string {
  const sections: string[] = []

  sections.push('## Design Document Under Review\n')
  sections.push(params.docContent)

  if (params.previousSummary) {
    sections.push('\n## Previous Round Summary\n')
    sections.push(params.previousSummary)
  } else {
    sections.push(
      '\n## Previous Round Summary\n\nThis is the first review round. No prior discussion to reference.',
    )
  }

  if (params.contextFiles.size > 0) {
    sections.push('\n## Shared Context (Codebase Findings)\n')
    for (const [filename, content] of params.contextFiles) {
      sections.push(`### ${filename}\n`)
      sections.push(content)
      sections.push('')
    }
  }

  sections.push(`\n## This Round\n`)
  sections.push(
    `Round ${params.roundNumber} of ${params.roundLimit}.${params.roundInstructions ? ` ${params.roundInstructions}` : ''}`,
  )

  sections.push(`\n## Your Task\n`)
  sections.push(
    `Review the design document through your critical lens. Reference specific sections of the doc when making points. Build on or rebut points from the previous round summary. If you have nothing new to add, respond with just "PASS".`,
  )

  return sections.join('\n')
}

export function assembleFacilitatorPrompt(params: AssembleFacilitatorPromptParams): string {
  const sections: string[] = []

  sections.push('## Design Document Under Review\n')
  sections.push(params.docContent)

  if (params.previousSummary) {
    sections.push('\n## Previous Round Summary\n')
    sections.push(params.previousSummary)
  }

  sections.push("\n## This Round's Agent Responses\n")
  for (const [persona, response] of params.agentResponses) {
    sections.push(`### ${persona}\n`)
    sections.push(response)
    sections.push('')
  }

  sections.push(`\n## Your Task\n`)
  sections.push(
    `Summarize round ${params.roundNumber} of ${params.roundLimit}. Follow your output format exactly. Be concise and accurate.`,
  )

  return sections.join('\n')
}

export function assembleOrientationPrompt(docContent: string): string {
  return `## Design Document\n\n${docContent}\n\n## Your Task\n\nRead the design document above and produce:\n1. A brief summary (3-5 sentences) of what is being proposed\n2. Key questions or areas that will need the most scrutiny\n3. Any sections that are unclear or need fleshing out before review can be productive\n\nThis is round 0 (orientation). The review panel has not spoken yet.`
}
