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

type AgentStreamCallback = (delta: string) => void

type AgentDebugCallback = (msg: string) => void

const STREAM_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

// --- Service ---

export class AgentService extends Context.Tag('AgentService')<
  AgentService,
  {
    readonly invoke: (params: AgentInvokeParams) => Effect.Effect<AgentResult, AgentInvokeError>
    readonly invokeStreaming: (
      params: AgentInvokeParams,
      onDelta: AgentStreamCallback,
      onDebug?: AgentDebugCallback,
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

// --- SSE event stream processing (extracted for testability) ---

export interface SseEvent {
  type: string
  properties: Record<string, unknown>
}

interface ProcessEventStreamParams {
  sessionId: string
  persona: string
  stream: AsyncIterable<unknown>
  onDelta: AgentStreamCallback
  onDebug?: AgentDebugCallback
  timeoutMs?: number
  /** called on session.idle to fetch final cost/token data; returns partial AgentResult fields */
  fetchCompletionData?: (
    sessionId: string,
  ) => Promise<{ costUsd: number; tokens: AgentTokenUsage; modelId: string; providerId: string }>
}

export function processEventStream(params: ProcessEventStreamParams): Promise<AgentResult> {
  const {
    sessionId,
    persona,
    stream,
    onDelta,
    onDebug: dbg = () => {},
    timeoutMs = STREAM_TIMEOUT_MS,
    fetchCompletionData,
  } = params

  const startTime = Date.now()

  return new Promise<AgentResult>((resolve, reject) => {
    let lastContent = ''
    let eventCount = 0
    let resolved = false

    const fallbackResult = (): AgentResult => ({
      persona,
      content: lastContent,
      sessionId,
      costUsd: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      modelId: 'unknown',
      providerId: 'unknown',
    })

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        dbg(
          `[${persona}] TIMEOUT after ${elapsed}s (${eventCount} events received, content length: ${lastContent.length})`,
        )
        if (lastContent.length > 0) {
          resolve(fallbackResult())
        } else {
          reject(new Error(`streaming timeout for ${persona} after ${elapsed}s with no content`))
        }
      }
    }, timeoutMs)

    const processEvents = async () => {
      try {
        for await (const event of stream) {
          if (resolved) return

          const payload = event as SseEvent
          if (!payload?.type) continue

          eventCount++
          const props = payload.properties
          const evtSession =
            (props?.sessionID as string) ??
            ((props?.part as Record<string, unknown>)?.sessionID as string) ??
            'n/a'
          dbg(`[${persona}] event #${eventCount}: ${payload.type} (session: ${evtSession})`)

          const part = props.part as Record<string, unknown> | undefined

          // streaming text delta
          if (
            payload.type === 'message.part.delta' &&
            props.sessionID === sessionId &&
            props.field === 'text'
          ) {
            onDelta(props.delta as string)
          }

          // accumulated text (for final content)
          if (
            payload.type === 'message.part.updated' &&
            part?.type === 'text' &&
            part.sessionID === sessionId
          ) {
            lastContent = part.text as string
          }

          // session finished
          if (payload.type === 'session.idle' && props.sessionID === sessionId) {
            clearTimeout(timer)
            resolved = true
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            dbg(`[${persona}] session.idle received after ${elapsed}s (${eventCount} events)`)

            if (fetchCompletionData) {
              try {
                const data = await fetchCompletionData(sessionId)
                resolve({ persona, content: lastContent, sessionId, ...data })
              } catch {
                resolve(fallbackResult())
              }
            } else {
              resolve(fallbackResult())
            }
            return
          }
        }

        // stream ended without session.idle
        if (!resolved) {
          clearTimeout(timer)
          resolved = true
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
          dbg(
            `[${persona}] SSE stream ended without session.idle after ${elapsed}s (${eventCount} events, content length: ${lastContent.length})`,
          )
          resolve(fallbackResult())
        }
      } catch (err) {
        if (!resolved) {
          clearTimeout(timer)
          resolved = true
          reject(err)
        }
      }
    }

    processEvents()
  })
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
      invokeStreaming: (params, onDelta, onDebug) =>
        Effect.gen(function* () {
          const dbg = onDebug ?? (() => {})
          const sessionId = yield* createSession(client, params.persona)
          dbg(`[${params.persona}] session created: ${sessionId}`)

          // subscribe to SSE events before sending the prompt
          const eventStream = yield* Effect.tryPromise({
            try: () => client.event.subscribe(),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })
          dbg(`[${params.persona}] SSE stream subscribed`)

          // send prompt async (returns immediately)
          yield* Effect.tryPromise({
            try: () =>
              client.session.promptAsync({
                path: { id: sessionId },
                body: buildPromptBody(params),
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })
          dbg(`[${params.persona}] prompt sent (async)`)

          // consume SSE events, emit text deltas, resolve when session goes idle
          const result = yield* Effect.tryPromise({
            try: () =>
              processEventStream({
                sessionId,
                persona: params.persona,
                stream: eventStream.stream,
                onDelta,
                onDebug: dbg,
                fetchCompletionData: async (sid) => {
                  const messages = await client.session.messages({ path: { id: sid } })
                  const items = messages.data ?? []
                  const assistantItem = [...items]
                    .reverse()
                    .find((m) => m.info.role === 'assistant')
                  if (assistantItem && assistantItem.info.role === 'assistant') {
                    const info = assistantItem.info
                    return {
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
                  throw new Error('no assistant message found')
                },
              }),
            catch: (e) => new AgentInvokeError({ persona: params.persona, cause: e }),
          })

          return result
        }),
    })
  }),
)
