import { Schema } from 'effect'

// --- Branded types ---

const SessionId = Schema.String.pipe(
  Schema.brand('SessionId'),
  Schema.annotations({ description: 'Unique session identifier (session-{ulid})' }),
)
export const makeSessionId = Schema.decodeSync(SessionId)

// --- Enums ---

const SessionMode = Schema.Literal('live', 'async')

const SessionStatus = Schema.Literal(
  'setup',
  'orientation',
  'reviewing',
  'converging',
  'complete',
  'error',
)

// --- Model config ---

const ModelConfig = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
})

// --- Round state ---

const RoundState = Schema.Struct({
  roundNumber: Schema.Number,
  status: Schema.Literal('pending', 'in_progress', 'summarizing', 'complete'),
  agentsCompleted: Schema.Array(Schema.String),
  hasHumanInput: Schema.optional(Schema.Boolean),
  summary: Schema.optional(Schema.String),
})

// --- Session manifest (session.json) ---

export const SessionManifest = Schema.Struct({
  id: SessionId,
  doc: Schema.String,
  codebasePath: Schema.optional(Schema.String),
  mode: SessionMode,
  roundLimit: Schema.Number,
  currentRound: Schema.Number,
  status: SessionStatus,
  panel: Schema.Array(Schema.String),
  facilitator: Schema.optionalWith(Schema.String, { default: () => 'default' }),
  models: Schema.optional(
    Schema.Struct({
      default: ModelConfig,
    }).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: ModelConfig }))),
  ),
  rounds: Schema.optionalWith(Schema.Array(RoundState), { default: () => [] }),
  totalCostUsd: Schema.optionalWith(Schema.Number, { default: () => 0 }),
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
})
export type SessionManifest = typeof SessionManifest.Type

// --- Session creation options ---

export const CreateSessionOptions = Schema.Struct({
  docPath: Schema.String,
  panel: Schema.Array(Schema.String),
  mode: SessionMode,
  roundLimit: Schema.Number,
  codebasePath: Schema.optional(Schema.String),
  models: Schema.optional(
    Schema.Struct({
      default: ModelConfig,
    }).pipe(Schema.extend(Schema.Record({ key: Schema.String, value: ModelConfig }))),
  ),
})
export type CreateSessionOptions = typeof CreateSessionOptions.Type
