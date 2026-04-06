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

export class AgentSpawnError extends Data.TaggedError('AgentSpawnError')<{
  readonly persona: string
  readonly cause: unknown
}> {}

export class AgentTimeoutError extends Data.TaggedError('AgentTimeoutError')<{
  readonly persona: string
  readonly round: number
}> {}

export class AgentBudgetExceeded extends Data.TaggedError('AgentBudgetExceeded')<{
  readonly persona: string
  readonly costUsd: number
}> {}

export class FacilitatorError extends Data.TaggedError('FacilitatorError')<{
  readonly round: number
  readonly cause: unknown
}> {}
