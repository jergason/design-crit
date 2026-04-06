import { Context, Effect, Layer, Data } from 'effect'
import type { TextPart, Part } from '@opencode-ai/sdk'
import { OpenCodeServer } from './opencode-server.js'

const isTextPart = (p: Part): p is TextPart => p.type === 'text'

// --- Errors ---

export class AgentInvokeError extends Data.TaggedError('AgentInvokeError')<{
  readonly persona: string
  readonly cause: unknown
}> {}

// --- Types ---

export interface AgentInvokeParams {
  readonly persona: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly model?: { providerID: string; modelID: string }
}

export interface AgentTokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export interface AgentResult {
  readonly persona: string
  readonly content: string
  readonly sessionId: string
  readonly costUsd: number
  readonly tokens: AgentTokenUsage
  readonly modelId: string
  readonly providerId: string
}

// --- Service ---

export class AgentService extends Context.Tag('AgentService')<
  AgentService,
  {
    readonly invoke: (params: AgentInvokeParams) => Effect.Effect<AgentResult, AgentInvokeError>
  }
>() {}

// --- Live implementation ---

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function* () {
    const { client } = yield* OpenCodeServer

    return AgentService.of({
      invoke: (params) =>
        Effect.gen(function* () {
          // create a fresh session for this persona
          const session = yield* Effect.tryPromise({
            try: () =>
              client.session.create({
                body: { title: `review-${params.persona}` },
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          if (!session.data) {
            return yield* Effect.fail(
              new AgentInvokeError({
                persona: params.persona,
                cause: session.error ?? 'session creation returned no data',
              }),
            )
          }

          const sessionId = session.data.id

          // send the review prompt
          const result = yield* Effect.tryPromise({
            try: () =>
              client.session.prompt({
                path: { id: sessionId },
                body: {
                  system: params.systemPrompt,
                  parts: [{ type: 'text' as const, text: params.prompt }],
                  ...(params.model ? { model: params.model } : {}),
                },
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          if (!result.data) {
            return yield* Effect.fail(
              new AgentInvokeError({
                persona: params.persona,
                cause: result.error ?? 'prompt returned no data',
              }),
            )
          }

          // extract text from response parts
          const content = result.data.parts
            .filter(isTextPart)
            .map((p) => p.text)
            .join('\n')

          const info = result.data.info
          return {
            persona: params.persona,
            content,
            sessionId,
            costUsd: info.cost,
            tokens: {
              input: info.tokens.input,
              output: info.tokens.output,
              reasoning: info.tokens.reasoning,
              cacheRead: info.tokens.cache.read,
              cacheWrite: info.tokens.cache.write,
            },
            modelId: info.modelID,
            providerId: info.providerID,
          }
        }),
    })
  }),
)
