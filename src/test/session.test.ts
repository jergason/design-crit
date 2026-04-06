import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Effect, Exit, Layer } from 'effect'
import { NodeFileSystem } from '@effect/platform-node'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService, SessionServiceLive } from '../engine/services/session.js'
import type { SessionManifest } from '../engine/schema.js'
import { SessionNotFound, SessionCorrupted } from '../engine/errors.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-crit-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// helper: create a test doc in the tmp dir
function createTestDoc(content = '# Test Design\n\nThis is a test.') {
  const docPath = path.join(tmpDir, 'test-doc.md')
  fs.writeFileSync(docPath, content)
  return docPath
}

// helper: run an effect with the session service
function runWithService<A, E>(
  effect: Effect.Effect<A, E, SessionService>,
): Promise<Exit.Exit<A, E>> {
  const sessionsDir = path.join(tmpDir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  const layer = SessionServiceLive(sessionsDir).pipe(Layer.provide(NodeFileSystem.layer))
  return Effect.exit(effect).pipe(Effect.provide(layer), Effect.runPromise)
}

describe('SessionService', () => {
  describe('create', () => {
    it('creates a session directory with correct structure', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          return yield* svc.create({
            docPath,
            panel: ['pragmatist', 'scope-hawk'],
            mode: 'live',
            roundLimit: 3,
          })
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      const manifest = exit.value
      expect(manifest.id).toMatch(/^session-/)
      expect(manifest.status).toBe('setup')
      expect(manifest.panel).toEqual(['pragmatist', 'scope-hawk'])
      expect(manifest.mode).toBe('live')
      expect(manifest.roundLimit).toBe(3)
      expect(manifest.currentRound).toBe(-1)
      expect(manifest.totalCostUsd).toBe(0)

      // verify directory structure
      const sessionDir = path.join(tmpDir, 'sessions', manifest.id)
      expect(fs.existsSync(path.join(sessionDir, 'session.json'))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, 'doc.md'))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, 'context'))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, 'rounds'))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, 'output'))).toBe(true)
      expect(fs.existsSync(path.join(sessionDir, 'sidebars'))).toBe(true)

      // verify doc was copied
      const copiedDoc = fs.readFileSync(path.join(sessionDir, 'doc.md'), 'utf-8')
      expect(copiedDoc).toBe('# Test Design\n\nThis is a test.')
    })
  })

  describe('load', () => {
    it('roundtrips create -> load', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist'],
            mode: 'async',
            roundLimit: 5,
          })
          const loaded = yield* svc.load(created.id)
          return { created, loaded }
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      const { created, loaded } = exit.value
      expect(loaded.id).toBe(created.id)
      expect(loaded.status).toBe(created.status)
      expect(loaded.panel).toEqual(created.panel)
      expect(loaded.mode).toBe(created.mode)
      expect(loaded.roundLimit).toBe(created.roundLimit)
    })

    it('fails with SessionNotFound for nonexistent session', async () => {
      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          return yield* svc.load('session-nonexistent')
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause
      expect(error._tag).toBe('Fail')
      if (error._tag === 'Fail') {
        expect(error.error).toBeInstanceOf(SessionNotFound)
      }
    })

    it('fails with SessionCorrupted for invalid JSON', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist'],
            mode: 'live',
            roundLimit: 3,
          })

          // corrupt the session.json
          const sessionDir = path.join(tmpDir, 'sessions', created.id)
          fs.writeFileSync(path.join(sessionDir, 'session.json'), 'not json!!!')

          return yield* svc.load(created.id)
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (!Exit.isFailure(exit)) return

      const error = exit.cause
      expect(error._tag).toBe('Fail')
      if (error._tag === 'Fail') {
        expect(error.error).toBeInstanceOf(SessionCorrupted)
      }
    })
  })

  describe('save', () => {
    it('persists modified state', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist'],
            mode: 'live',
            roundLimit: 3,
          })

          // modify and save
          const modified: SessionManifest = {
            ...created,
            status: 'reviewing',
            currentRound: 1,
            totalCostUsd: 0.42,
          }
          yield* svc.save(modified)

          // reload and verify
          const reloaded = yield* svc.load(created.id)
          return reloaded
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      expect(exit.value.status).toBe('reviewing')
      expect(exit.value.currentRound).toBe(1)
      expect(exit.value.totalCostUsd).toBe(0.42)
    })
  })

  describe('round files', () => {
    it('writes and reads round files', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist'],
            mode: 'live',
            roundLimit: 3,
          })

          yield* svc.writeRoundFile(
            created.id,
            1,
            'pragmatist.md',
            '# Pragmatist Review\n\nThis will never ship.',
          )

          yield* svc.writeRoundFile(
            created.id,
            1,
            'summary.md',
            '# Round 1 Summary\n\nOne concern raised.',
          )

          const review = yield* svc.readRoundFile(created.id, 1, 'pragmatist.md')
          const summary = yield* svc.readRoundFile(created.id, 1, 'summary.md')

          return { review, summary }
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      expect(exit.value.review).toContain('This will never ship.')
      expect(exit.value.summary).toContain('One concern raised.')
    })
  })

  describe('context files', () => {
    it('writes and lists context files', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist'],
            mode: 'live',
            roundLimit: 3,
          })

          yield* svc.writeContextFile(created.id, 'auth-analysis.md', '# Auth Module\n\nUses JWT.')

          yield* svc.writeContextFile(
            created.id,
            'perf-findings.md',
            '# Performance\n\nN+1 query found.',
          )

          const files = yield* svc.listContextFiles(created.id)
          return files
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      expect(exit.value).toHaveLength(2)
      expect(exit.value).toContain('auth-analysis.md')
      expect(exit.value).toContain('perf-findings.md')
    })
  })

  describe('getAllRoundResponses', () => {
    it('returns all round responses as nested map', async () => {
      const docPath = createTestDoc()

      const exit = await runWithService(
        Effect.gen(function* () {
          const svc = yield* SessionService
          const created = yield* svc.create({
            docPath,
            panel: ['pragmatist', 'scope-hawk'],
            mode: 'live',
            roundLimit: 3,
          })

          // write round 0 (orientation)
          yield* svc.writeRoundFile(created.id, 0, 'facilitator.md', 'Orientation summary')

          // write round 1
          yield* svc.writeRoundFile(created.id, 1, 'pragmatist.md', 'Pragmatist round 1')
          yield* svc.writeRoundFile(created.id, 1, 'scope-hawk.md', 'Scope hawk round 1')
          yield* svc.writeRoundFile(created.id, 1, 'summary.md', 'Round 1 summary')

          return yield* svc.getAllRoundResponses(created.id)
        }),
      )

      expect(Exit.isSuccess(exit)).toBe(true)
      if (!Exit.isSuccess(exit)) return

      const responses = exit.value
      expect(responses.size).toBe(2)

      const round0 = responses.get(0)!
      expect(round0.get('facilitator')).toBe('Orientation summary')

      const round1 = responses.get(1)!
      expect(round1.get('pragmatist')).toBe('Pragmatist round 1')
      expect(round1.get('scope-hawk')).toBe('Scope hawk round 1')
      expect(round1.get('summary')).toBe('Round 1 summary')
    })
  })
})
