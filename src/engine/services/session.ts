import { Context, Effect, Layer, Schema, pipe } from 'effect'
import { FileSystem } from '@effect/platform'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { SessionManifest, CreateSessionOptions } from '../schema.js'
import { SessionManifest as SessionManifestSchema, makeSessionId } from '../schema.js'
import { SessionNotFound, SessionCorrupted, SessionWriteError } from '../errors.js'

// --- ID generation ---

function generateSessionId(): string {
  const timestamp = Date.now().toString(36)
  const random = crypto.randomBytes(8).toString('base64url')
  return `session-${timestamp}-${random}`
}

// --- Service interface ---

export class SessionService extends Context.Tag('SessionService')<
  SessionService,
  {
    readonly sessionsDir: string

    readonly create: (
      opts: CreateSessionOptions,
    ) => Effect.Effect<SessionManifest, SessionWriteError>

    readonly load: (
      id: string,
    ) => Effect.Effect<SessionManifest, SessionNotFound | SessionCorrupted>

    readonly save: (manifest: SessionManifest) => Effect.Effect<void, SessionWriteError>

    readonly getDocContent: (id: string) => Effect.Effect<string, SessionNotFound>

    readonly writeRoundFile: (
      id: string,
      round: number,
      filename: string,
      content: string,
    ) => Effect.Effect<void, SessionWriteError>

    readonly readRoundFile: (
      id: string,
      round: number,
      filename: string,
    ) => Effect.Effect<string, SessionNotFound>

    readonly listContextFiles: (id: string) => Effect.Effect<string[], SessionNotFound>

    readonly writeContextFile: (
      id: string,
      filename: string,
      content: string,
    ) => Effect.Effect<void, SessionWriteError>

    readonly getAllRoundResponses: (
      id: string,
    ) => Effect.Effect<Map<number, Map<string, string>>, SessionNotFound>
  }
>() {}

// --- Live implementation ---

const roundDirName = (round: number) => `round-${String(round).padStart(2, '0')}`

export const SessionServiceLive = (sessionsDir: string) =>
  Layer.effect(
    SessionService,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const writeAtomic = (filePath: string, content: string) =>
        pipe(
          Effect.flatMap(fs.writeFileString(`${filePath}.tmp`, content), () =>
            fs.rename(`${filePath}.tmp`, filePath),
          ),
          Effect.mapError((e) => new SessionWriteError({ path: filePath, cause: e })),
        )

      return SessionService.of({
        sessionsDir,

        create: (opts) =>
          Effect.gen(function* () {
            const id = generateSessionId()
            const sessionDir = path.join(sessionsDir, id)

            yield* pipe(
              Effect.all([
                fs.makeDirectory(path.join(sessionDir, 'context'), {
                  recursive: true,
                }),
                fs.makeDirectory(path.join(sessionDir, 'rounds'), {
                  recursive: true,
                }),
                fs.makeDirectory(path.join(sessionDir, 'output'), {
                  recursive: true,
                }),
                fs.makeDirectory(path.join(sessionDir, 'sidebars'), {
                  recursive: true,
                }),
              ]),
              Effect.mapError((e) => new SessionWriteError({ path: sessionDir, cause: e })),
            )

            const docContent = yield* pipe(
              fs.readFileString(opts.docPath),
              Effect.mapError((e) => new SessionWriteError({ path: opts.docPath, cause: e })),
            )
            yield* pipe(
              fs.writeFileString(path.join(sessionDir, 'doc.md'), docContent),
              Effect.mapError(
                (e) =>
                  new SessionWriteError({
                    path: path.join(sessionDir, 'doc.md'),
                    cause: e,
                  }),
              ),
            )

            const manifest: SessionManifest = {
              id: makeSessionId(id),
              doc: 'doc.md',
              codebasePath: opts.codebasePath,
              mode: opts.mode,
              roundLimit: opts.roundLimit,
              currentRound: -1,
              status: 'setup',
              panel: opts.panel,
              facilitator: 'default',
              models: opts.models,
              rounds: [],
              totalCostUsd: 0,
              createdAt: new Date().toISOString(),
            }

            yield* writeAtomic(
              path.join(sessionDir, 'session.json'),
              JSON.stringify(manifest, null, 2),
            )

            return manifest
          }),

        load: (id) =>
          Effect.gen(function* () {
            const manifestPath = path.join(sessionsDir, id, 'session.json')

            const exists = yield* pipe(
              fs.exists(manifestPath),
              Effect.mapError(() => new SessionNotFound({ id })),
            )
            if (!exists) return yield* Effect.fail(new SessionNotFound({ id }))

            const raw = yield* pipe(
              fs.readFileString(manifestPath),
              Effect.mapError(() => new SessionNotFound({ id })),
            )

            let parsed: unknown
            try {
              parsed = JSON.parse(raw)
            } catch {
              return yield* Effect.fail(new SessionCorrupted({ id, reason: 'invalid JSON' }))
            }

            return yield* pipe(
              Schema.decodeUnknown(SessionManifestSchema)(parsed),
              Effect.mapError(
                (e) =>
                  new SessionCorrupted({
                    id,
                    reason: `schema validation failed: ${e.message}`,
                  }),
              ),
            )
          }),

        save: (manifest) =>
          writeAtomic(
            path.join(sessionsDir, manifest.id, 'session.json'),
            JSON.stringify(manifest, null, 2),
          ),

        getDocContent: (id) =>
          pipe(
            fs.readFileString(path.join(sessionsDir, id, 'doc.md')),
            Effect.mapError(() => new SessionNotFound({ id })),
          ),

        writeRoundFile: (id, round, filename, content) =>
          Effect.gen(function* () {
            const roundDir = path.join(sessionsDir, id, 'rounds', roundDirName(round))
            yield* pipe(
              fs.makeDirectory(roundDir, { recursive: true }),
              Effect.mapError((e) => new SessionWriteError({ path: roundDir, cause: e })),
            )
            yield* pipe(
              fs.writeFileString(path.join(roundDir, filename), content),
              Effect.mapError(
                (e) =>
                  new SessionWriteError({
                    path: path.join(roundDir, filename),
                    cause: e,
                  }),
              ),
            )
          }),

        readRoundFile: (id, round, filename) =>
          pipe(
            fs.readFileString(path.join(sessionsDir, id, 'rounds', roundDirName(round), filename)),
            Effect.mapError(() => new SessionNotFound({ id })),
          ),

        listContextFiles: (id) =>
          Effect.gen(function* () {
            const contextDir = path.join(sessionsDir, id, 'context')
            const exists = yield* pipe(
              fs.exists(contextDir),
              Effect.mapError(() => new SessionNotFound({ id })),
            )
            if (!exists) return []
            const entries = yield* pipe(
              fs.readDirectory(contextDir),
              Effect.mapError(() => new SessionNotFound({ id })),
            )
            return [...entries].filter((e: string) => e.endsWith('.md'))
          }),

        writeContextFile: (id, filename, content) =>
          pipe(
            fs.writeFileString(path.join(sessionsDir, id, 'context', filename), content),
            Effect.mapError(
              (e) =>
                new SessionWriteError({
                  path: path.join(sessionsDir, id, 'context', filename),
                  cause: e,
                }),
            ),
          ),

        getAllRoundResponses: (id) =>
          Effect.gen(function* () {
            const roundsDir = path.join(sessionsDir, id, 'rounds')
            const exists = yield* pipe(
              fs.exists(roundsDir),
              Effect.mapError(() => new SessionNotFound({ id })),
            )
            if (!exists) return new Map()

            const roundDirs = yield* pipe(
              fs.readDirectory(roundsDir),
              Effect.mapError(() => new SessionNotFound({ id })),
            )

            const result = new Map<number, Map<string, string>>()

            for (const dir of [...roundDirs].sort()) {
              const match = dir.match(/^round-(\d+)$/)
              if (!match) continue
              const roundNum = parseInt(match[1], 10)
              const roundPath = path.join(roundsDir, dir)

              const files = yield* pipe(
                fs.readDirectory(roundPath),
                Effect.mapError(() => new SessionNotFound({ id })),
              )

              const responses = new Map<string, string>()
              for (const file of files) {
                if (!file.endsWith('.md')) continue
                const content = yield* pipe(
                  fs.readFileString(path.join(roundPath, file)),
                  Effect.mapError(() => new SessionNotFound({ id })),
                )
                responses.set(file.replace(/\.md$/, ''), content)
              }
              result.set(roundNum, responses)
            }

            return result
          }),
      })
    }),
  )
