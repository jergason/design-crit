import { Effect } from 'effect'
import { SessionService } from './session.js'
import { AgentService } from './agent.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

function loadFacilitatorPrompt(personasDir: string): string {
  const filePath = path.join(personasDir, 'facilitator.md')
  if (!fs.existsSync(filePath)) return 'You are a facilitator summarizing a design review.'
  return fs.readFileSync(filePath, 'utf-8')
}

export function generateOutput(params: {
  sessionId: string
  personasDir: string
  onEvent?: (event: OutputEvent) => void
}) {
  const emit = params.onEvent ?? (() => {})

  return Effect.gen(function* () {
    const sessionSvc = yield* SessionService
    const agentSvc = yield* AgentService

    const manifest = yield* sessionSvc.load(params.sessionId)
    const docContent = yield* sessionSvc.getDocContent(params.sessionId)
    const allRounds = yield* sessionSvc.getAllRoundResponses(params.sessionId)

    // collect all summaries
    const summaries: string[] = []
    for (const [roundNum, responses] of allRounds) {
      const summary = responses.get('summary')
      if (summary) summaries.push(`## Round ${roundNum} Summary\n\n${summary}`)
    }
    const allSummariesText = summaries.join('\n\n---\n\n')

    const facilitatorPrompt = loadFacilitatorPrompt(params.personasDir)

    // generate review notes
    emit({ type: 'generating', artifact: 'review-notes' })

    const notesResult = yield* agentSvc.invoke({
      persona: 'facilitator',
      systemPrompt: facilitatorPrompt,
      prompt: `## Design Document\n\n${docContent}\n\n## All Round Summaries\n\n${allSummariesText}\n\n## Your Task\n\nProduce structured review notes for this completed design review session.\n\nInclude:\n- **Session metadata**: panel used (${manifest.panel.join(', ')}), rounds completed (${manifest.currentRound}), mode (${manifest.mode})\n- **Key discussion points**: the main topics debated, with brief summaries of positions taken\n- **Decisions**: what was agreed on, with rationale\n- **Dissenting opinions**: where consensus was NOT reached, and why\n- **Open questions**: things that need more investigation or input\n- **Action items**: concrete next steps surfaced during the review\n\nBe concise and structured. Use markdown formatting.`,
    })

    const outputDir = path.join(sessionSvc.sessionsDir, params.sessionId, 'output')
    fs.writeFileSync(path.join(outputDir, 'review-notes.md'), notesResult.content)

    emit({
      type: 'complete',
      artifact: 'review-notes',
      cost: notesResult.costUsd,
      tokens: notesResult.tokens.input + notesResult.tokens.output,
    })

    // generate revised doc
    emit({ type: 'generating', artifact: 'revised-doc' })

    const revisedResult = yield* agentSvc.invoke({
      persona: 'facilitator',
      systemPrompt: facilitatorPrompt,
      prompt: `## Original Design Document\n\n${docContent}\n\n## Review Discussion Summaries\n\n${allSummariesText}\n\n## Your Task\n\nProduce a revised version of the original design document that incorporates the feedback that was agreed upon during the review.\n\nRules:\n- Preserve the original document's structure and voice\n- Only make changes that are motivated by decisions or consensus from the review\n- For each significant change, add a brief inline note like <!-- Review: [reason] --> explaining why\n- If a section was contested without consensus, keep the original and add a note about the open question\n- Do NOT silently drop content from the original\n- Output the complete revised document in markdown`,
    })

    fs.writeFileSync(path.join(outputDir, 'revised-doc.md'), revisedResult.content)

    emit({
      type: 'complete',
      artifact: 'revised-doc',
      cost: revisedResult.costUsd,
      tokens: revisedResult.tokens.input + revisedResult.tokens.output,
    })

    return {
      reviewNotesPath: path.join(outputDir, 'review-notes.md'),
      revisedDocPath: path.join(outputDir, 'revised-doc.md'),
      totalCost: notesResult.costUsd + revisedResult.costUsd,
    }
  })
}

export type OutputEvent =
  | { type: 'generating'; artifact: string }
  | { type: 'complete'; artifact: string; cost: number; tokens: number }
