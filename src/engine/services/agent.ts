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

export type AgentStreamCallback = (delta: string) => void

// --- Service ---

export class AgentService extends Context.Tag('AgentService')<
  AgentService,
  {
    readonly invoke: (params: AgentInvokeParams) => Effect.Effect<AgentResult, AgentInvokeError>
    readonly invokeStreaming: (
      params: AgentInvokeParams,
      onDelta: AgentStreamCallback,
    ) => Effect.Effect<AgentResult, AgentInvokeError>
  }
>() {}

// --- Helpers ---

function createSession(client: import('@opencode-ai/sdk').OpencodeClient, persona: string) {
  return Effect.tryPromise({
    try: () => client.session.create({ body: { title: `review-${persona}` } }),
    catch: (e) => new AgentInvokeError({ persona, cause: e }),
  }).pipe(
    Effect.flatMap((session) =>
      session.data
        ? Effect.succeed(session.data.id)
        : Effect.fail(
            new AgentInvokeError({
              persona,
              cause: session.error ?? 'session creation returned no data',
            }),
          ),
    ),
  )
}

function extractResult(
  persona: string,
  sessionId: string,
  data: { info: import('@opencode-ai/sdk').AssistantMessage; parts: Part[] },
): AgentResult {
  const content = data.parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join('\n')
  const info = data.info
  return {
    persona,
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
}

function buildPromptBody(params: AgentInvokeParams) {
  return {
    system: params.systemPrompt,
    parts: [{ type: 'text' as const, text: params.prompt }],
    ...(params.model ? { model: params.model } : {}),
  }
}

// --- Live implementation ---

export const AgentServiceLive = Layer.effect(
  AgentService,
  Effect.gen(function* () {
    const { client } = yield* OpenCodeServer

    return AgentService.of({
      // blocking invoke — waits for full response
      invoke: (params) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(client, params.persona)

          const result = yield* Effect.tryPromise({
            try: () =>
              client.session.prompt({
                path: { id: sessionId },
                body: buildPromptBody(params),
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

          return extractResult(params.persona, sessionId, result.data)
        }),

      // streaming invoke — calls onDelta with text chunks as they arrive
      invokeStreaming: (params, onDelta) =>
        Effect.gen(function* () {
          const sessionId = yield* createSession(client, params.persona)

          // subscribe to SSE events before sending the prompt
          const eventStream = yield* Effect.tryPromise({
            try: () => client.event.subscribe(),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          // send prompt async (returns immediately)
          yield* Effect.tryPromise({
            try: () =>
              client.session.promptAsync({
                path: { id: sessionId },
                body: buildPromptBody(params),
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          // consume SSE events, emit text deltas, resolve when session goes idle
          const result = yield* Effect.tryPromise({
            try: () =>
              new Promise<AgentResult>((resolve, reject) => {
                let lastContent = ''
                const fallbackResult = (): AgentResult => ({
                  persona: params.persona,
                  content: lastContent,
                  sessionId,
                  costUsd: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
                  modelId: 'unknown',
                  providerId: 'unknown',
                })

                const processEvents = async () => {
                  try {
                    for await (const event of eventStream.stream) {
                      const payload = (event as { payload?: import('@opencode-ai/sdk').Event })
                        .payload
                      if (!payload) continue

                      // text delta from the agent
                      if (
                        payload.type === 'message.part.updated' &&
                        payload.properties.part.type === 'text' &&
                        payload.properties.part.sessionID === sessionId &&
                        payload.properties.delta
                      ) {
                        onDelta(payload.properties.delta)
                        lastContent = payload.properties.part.text
                      }

                      // session finished
                      if (
                        payload.type === 'session.idle' &&
                        payload.properties.sessionID === sessionId
                      ) {
                        // fetch the final message to get cost/token data
                        const messages = await client.session.messages({
                          path: { id: sessionId },
                        })
                        const items = messages.data ?? []
                        const assistantItem = [...items]
                          .reverse()
                          .find((m) => m.info.role === 'assistant')
                        if (assistantItem && assistantItem.info.role === 'assistant') {
                          const info = assistantItem.info
                          resolve({
                            persona: params.persona,
                            content: lastContent,
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
                          })
                        } else {
                          resolve(fallbackResult())
                        }
                        return
                      }
                    }
                  } catch (err) {
                    reject(err)
                  }
                }

                processEvents()
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          return result
        }),
    })
  }),
)
