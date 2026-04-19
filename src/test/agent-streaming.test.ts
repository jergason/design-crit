import { describe, it, expect, vi } from 'vitest'
import { processEventStream, type SseEvent } from '../engine/services/agent.js'

// --- helpers ---

/** create a fake async iterable from an array of events */
async function* fakeStream(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const e of events) yield e
}

/** create an event stream that hangs forever (never yields) */
async function* hangingStream(): AsyncGenerator<SseEvent> {
  await new Promise(() => {}) // never resolves
}

/** create a stream that yields events, then hangs */
async function* partialStream(events: SseEvent[]): AsyncGenerator<SseEvent> {
  for (const e of events) yield e
  await new Promise(() => {})
}

const SID = 'ses_test123'
const OTHER_SID = 'ses_other456'

function delta(text: string, sessionID = SID): SseEvent {
  return {
    type: 'message.part.delta',
    properties: { sessionID, field: 'text', delta: text },
  }
}

function partUpdated(text: string, sessionID = SID): SseEvent {
  return {
    type: 'message.part.updated',
    properties: { part: { type: 'text', sessionID, text } },
  }
}

function sessionIdle(sessionID = SID): SseEvent {
  return { type: 'session.idle', properties: { sessionID } }
}

function sessionStatus(sessionID = SID): SseEvent {
  return { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } }
}

// --- tests ---

describe('processEventStream', () => {
  describe('happy path', () => {
    it('resolves with accumulated content on session.idle', async () => {
      const deltas: string[] = []
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: fakeStream([
          sessionStatus(),
          delta('hello '),
          delta('world'),
          partUpdated('hello world'),
          sessionIdle(),
        ]),
        onDelta: (d) => deltas.push(d),
      })

      expect(result.persona).toBe('pragmatist')
      expect(result.content).toBe('hello world')
      expect(result.sessionId).toBe(SID)
      expect(deltas).toEqual(['hello ', 'world'])
    })

    it('calls fetchCompletionData on idle when provided', async () => {
      const fetchFn = vi.fn().mockResolvedValue({
        costUsd: 0.05,
        tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        modelId: 'test-model',
        providerId: 'test-provider',
      })

      const result = await processEventStream({
        sessionId: SID,
        persona: 'facilitator',
        stream: fakeStream([partUpdated('the answer'), sessionIdle()]),
        onDelta: () => {},
        fetchCompletionData: fetchFn,
      })

      expect(fetchFn).toHaveBeenCalledWith(SID)
      expect(result.costUsd).toBe(0.05)
      expect(result.tokens.input).toBe(100)
      expect(result.modelId).toBe('test-model')
      expect(result.content).toBe('the answer')
    })

    it('falls back if fetchCompletionData throws', async () => {
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: fakeStream([partUpdated('partial'), sessionIdle()]),
        onDelta: () => {},
        fetchCompletionData: async () => {
          throw new Error('network error')
        },
      })

      expect(result.content).toBe('partial')
      expect(result.costUsd).toBe(0)
      expect(result.modelId).toBe('unknown')
    })
  })

  describe('session filtering', () => {
    it('ignores events from other sessions', async () => {
      const deltas: string[] = []
      const result = await processEventStream({
        sessionId: SID,
        persona: 'scope-hawk',
        stream: fakeStream([
          delta('wrong session', OTHER_SID),
          partUpdated('wrong content', OTHER_SID),
          delta('right'),
          partUpdated('right'),
          sessionIdle(OTHER_SID), // should not resolve!
          sessionIdle(SID),
        ]),
        onDelta: (d) => deltas.push(d),
      })

      expect(deltas).toEqual(['right'])
      expect(result.content).toBe('right')
    })
  })

  describe('stream EOF without idle', () => {
    it('resolves with fallback when stream ends without session.idle', async () => {
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: fakeStream([
          delta('partial '),
          delta('content'),
          partUpdated('partial content'),
          // no session.idle — stream just ends
        ]),
        onDelta: () => {},
      })

      expect(result.content).toBe('partial content')
      expect(result.costUsd).toBe(0)
      expect(result.modelId).toBe('unknown')
    })

    it('resolves with empty content when stream ends with no events', async () => {
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: fakeStream([]),
        onDelta: () => {},
      })

      expect(result.content).toBe('')
    })
  })

  describe('timeout', () => {
    it('resolves with fallback on timeout when partial content exists', async () => {
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: partialStream([delta('partial'), partUpdated('partial')]),
        onDelta: () => {},
        timeoutMs: 50,
      })

      expect(result.content).toBe('partial')
      expect(result.modelId).toBe('unknown')
    })

    it('rejects on timeout with no content', async () => {
      await expect(
        processEventStream({
          sessionId: SID,
          persona: 'pragmatist',
          stream: hangingStream(),
          onDelta: () => {},
          timeoutMs: 50,
        }),
      ).rejects.toThrow(/streaming timeout.*pragmatist/)
    })
  })

  describe('stream errors', () => {
    it('rejects when the stream throws', async () => {
      async function* errorStream(): AsyncGenerator<SseEvent> {
        yield delta('before error')
        throw new Error('SSE connection lost')
      }

      await expect(
        processEventStream({
          sessionId: SID,
          persona: 'pragmatist',
          stream: errorStream(),
          onDelta: () => {},
        }),
      ).rejects.toThrow('SSE connection lost')
    })
  })

  describe('debug callback', () => {
    it('receives event log messages', async () => {
      const debugMsgs: string[] = []
      await processEventStream({
        sessionId: SID,
        persona: 'test',
        stream: fakeStream([delta('hi'), sessionIdle()]),
        onDelta: () => {},
        onDebug: (msg) => debugMsgs.push(msg),
      })

      expect(debugMsgs.some((m) => m.includes('message.part.delta'))).toBe(true)
      expect(debugMsgs.some((m) => m.includes('session.idle received'))).toBe(true)
    })
  })

  describe('malformed events', () => {
    it('skips events without a type field', async () => {
      const result = await processEventStream({
        sessionId: SID,
        persona: 'pragmatist',
        stream: fakeStream([
          { type: '', properties: {} } as SseEvent,
          { type: undefined as unknown as string, properties: {} } as SseEvent,
          partUpdated('survived'),
          sessionIdle(),
        ]),
        onDelta: () => {},
      })

      expect(result.content).toBe('survived')
    })
  })
})
