import { Data } from 'effect'

export class SessionNotFound extends Data.TaggedError('SessionNotFound')<{
  readonly id: string
}> {}

export class SessionCorrupted extends Data.TaggedError('SessionCorrupted')<{
  readonly id: string
  readonly reason: string
}> {}

export class SessionWriteError extends Data.TaggedError('SessionWriteError')<{
  readonly path: string
  readonly cause: unknown
}> {}
