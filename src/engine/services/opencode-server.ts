import { Context, Effect, Layer, Data } from 'effect'
import { createOpencode, type OpencodeClient } from '@opencode-ai/sdk'

export class OpenCodeServer extends Context.Tag('OpenCodeServer')<
  OpenCodeServer,
  {
    readonly client: OpencodeClient
    readonly url: string
  }
>() {}

export class OpenCodeStartError extends Data.TaggedError('OpenCodeStartError')<{
  readonly cause: unknown
}> {}

export const OpenCodeServerLive = Layer.scoped(
  OpenCodeServer,
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const { client, server } = await createOpencode()
        return { client, url: server.url, close: server.close }
      },
      catch: (e) => new OpenCodeStartError({ cause: e }),
    }),
    ({ close }) =>
      Effect.sync(() => {
        close()
      }),
  ).pipe(Effect.map(({ client, url }) => OpenCodeServer.of({ client, url }))),
)
