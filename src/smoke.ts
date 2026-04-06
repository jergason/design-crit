#!/usr/bin/env tsx
/**
 * Smoke test: start OpenCode server, create a session,
 * send one persona review prompt, print the response.
 */
import { createOpencode } from '@opencode-ai/sdk'
import * as fs from 'node:fs'

const PERSONA_SYSTEM = `# The Pragmatist

> "Will this actually ship, or are we building a cathedral?"

## Your Role
You are a battle-scarred engineer who has shipped dozens of products. You evaluate designs purely on whether they will actually get built, work in production, and deliver value. You are allergic to over-engineering, premature abstraction, and any plan that can't survive contact with reality.

## How You Argue
Direct, blunt, occasionally sarcastic. You ask "have you actually tried this?" a lot. You ground every criticism in concrete shipping risk. You respect ambition but distrust complexity.

## What You Watch For
- Scope that will balloon
- Abstractions without concrete use cases
- Missing error handling or failure modes
- Designs that assume happy paths
- Technology choices driven by novelty over fitness
- Timelines that don't account for integration pain

## What You Champion
- Simple solutions that can evolve
- Concrete milestones and deliverables
- Explicit tradeoff acknowledgment
- "Good enough" over "perfect"

## Rules
- Always ground criticism in specifics (quote the doc, cite patterns)
- If you have nothing new to add, say "PASS" and nothing else
- Keep responses under 500 words
- Never be polite at the expense of being honest
`

async function main() {
  const docPath = process.argv[2] || 'docs/design-doc.md'

  if (!fs.existsSync(docPath)) {
    console.error(`doc not found: ${docPath}`)
    process.exit(1)
  }

  const docContent = fs.readFileSync(docPath, 'utf-8')

  console.log('starting opencode server...')
  const { client, server } = await createOpencode()
  console.log(`server running at ${server.url}`)

  try {
    // list providers to see what's configured
    const providers = await client.config.providers()
    console.log('available providers:', providers.data ? Object.keys(providers.data) : 'none')

    // create a session
    console.log('creating session...')
    const session = await client.session.create({
      body: { title: 'smoke-test-review' },
    })
    if (!session.data) {
      console.error('failed to create session:', session.error)
      process.exit(1)
    }
    const sessionId = session.data.id
    console.log(`session created: ${sessionId}`)

    // send the review prompt
    console.log('sending prompt to pragmatist persona...')
    console.log('(this may take a minute)\n')

    const prompt = `## Design Document Under Review

${docContent}

## Your Task

Review this design document through your critical lens as The Pragmatist.
Focus on shipping risks, over-engineering, and missing failure modes.
Be specific — quote sections of the doc when making points.
Keep it under 500 words.`

    const result = await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: PERSONA_SYSTEM,
        parts: [{ type: 'text', text: prompt }],
      },
    })

    if (!result.data) {
      console.error('prompt failed:', result.error)
      process.exit(1)
    }

    console.log('='.repeat(60))
    console.log('THE PRAGMATIST REVIEW')
    console.log('='.repeat(60))
    console.log()

    for (const part of result.data.parts) {
      if ('text' in part && part.text) {
        console.log(part.text)
      }
    }

    console.log()
    console.log('='.repeat(60))
    console.log(`session: ${sessionId}`)
  } finally {
    server.close()
    console.log('server stopped')
  }
}

main().catch((err) => {
  console.error('smoke test failed:', err)
  process.exit(1)
})
