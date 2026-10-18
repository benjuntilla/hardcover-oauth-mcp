/** Shared parameter schemas and helpers for the Hardcover tools. */
import { Array as Arr, Effect, Option, Predicate, Record as Rec, Schema, String as Str, Struct, pipe } from "effect"
import type { GraphQL } from "effect/graphql"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"

const MIN_ID = 1
const MIN_LIMIT = 1
const MIN_OFFSET = 0
const PRIVACY_IDS = { followers: 2, private: 3, public: 1 } as const
const STATUS_IDS = { currently_reading: 2, did_not_finish: 5, ignored: 6, paused: 4, read: 3, want_to_read: 1 } as const

type PrivacyName = keyof typeof PRIVACY_IDS
type StatusName = keyof typeof STATUS_IDS

/**
 * A positive integer id.
 * @param {string} description What the id refers to, shown to the model.
 * @returns {Schema.Int} The id schema.
 */
const Id = (description: string): Schema.Int => Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_ID)).annotate({ description })

/**
 * An optional page size.
 * @param {object} options Bounds for the page size.
 * @param {number} options.max The largest page size allowed.
 * @param {number} options.fallback The page size used when omitted.
 * @returns {Schema.optionalKey<Schema.Int>} The optional page size schema.
 */
const Limit = (options: Readonly<{ max: number; fallback: number }>): Schema.optionalKey<Schema.Int> =>
  Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ maximum: options.max, minimum: MIN_LIMIT })).annotate({
      description: `How many to return (default ${options.fallback}, max ${options.max}).`,
    }),
  )

const Offset = Schema.optionalKey(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_OFFSET)).annotate({ description: "How many to skip, for paging." }),
)

/**
 * A calendar date.
 * @param {string} description What the date means, shown to the model.
 * @returns {Schema.String} The date schema.
 */
const DateString = (description: string): Schema.String =>
  Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/v)).annotate({ description: `${description} (YYYY-MM-DD).` })

const Privacy = Schema.Literals(["public", "followers", "private"]).annotate({
  description: "Who can see it: public, followers (people who follow you), or private. Omit to use Hardcover's default.",
})

/**
 * Hardcover's id for a privacy setting.
 * @param {PrivacyName} privacy The privacy name.
 * @returns {number} 1 public, 2 followers only, 3 private.
 */
const privacyId = (privacy: PrivacyName): number => PRIVACY_IDS[privacy]

const Status = Schema.Literals(["want_to_read", "currently_reading", "read", "paused", "did_not_finish", "ignored"]).annotate({
  description: "Reading status. ignored hides the book from recommendations.",
})

const STATUS_NAMES: Readonly<Record<number, StatusName>> = pipe(
  Rec.toEntries(STATUS_IDS),
  Arr.map(([name, id]) => [String(id), name] as const),
  Rec.fromEntries,
)

/** Any JSON value returned from Hardcover. */
const Json = Schema.Unknown
const JsonList = Schema.Array(Schema.Unknown)

/** A query or mutation whose variables and result need no services to encode and decode. */
type Operation<
  Variables extends Schema.Codec<unknown, Readonly<Record<string, unknown>>>,
  Result extends Schema.Decoder<unknown>,
> = GraphQL.Operation<"query" | "mutation", string, Variables, Result>

/**
 * Runs a query or mutation with the session's Hardcover client: encodes the
 * variables, sends the document under the operation's name, and decodes `data`.
 * Mutations are never retried after a timeout or server error. A `data` that
 * doesn't match the result schema is a defect, reported with the operation's
 * name only, since the response may hold user data.
 * @param {Operation} operation The operation, from `GraphQL.query` or `GraphQL.mutation`.
 * @returns {Function} A function from the operation's variables to its decoded data.
 */
const run =
  <Variables extends Schema.Codec<unknown, Readonly<Record<string, unknown>>>, Result extends Schema.Decoder<unknown>>(
    operation: Operation<Variables, Result>,
  ): ((variables: Variables["Type"]) => Effect.Effect<Result["Type"], HardcoverError, Session>) =>
  (variables) =>
    Effect.gen(function* runOperation() {
      const session = yield* Session
      const encoded = yield* Schema.encodeEffect(operation.variables)(variables).pipe(Effect.orDie)
      const data = yield* session.graphql(
        { operationName: operation.name, query: operation.document, variables: encoded },
        { mutation: operation.kind === "mutation" },
      )
      return yield* Schema.decodeUnknownEffect(operation.result)(data).pipe(
        Effect.catchTag("SchemaError", () => Effect.die(`Hardcover's response to ${operation.name} did not match the expected shape`)),
      )
    })

/** Hardcover's `[String]`: its items may be null too. */
const Messages = Schema.Array(Schema.NullOr(Schema.String))

/** The validation fields every Hardcover mutation payload may carry. */
const PayloadErrors = {
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errors: Schema.optionalKey(Schema.NullOr(Messages)),
}

/** A mutation payload schema with the validation fields added. */
type PayloadSchema<Fields extends Schema.Struct.Fields> = Schema.NullOr<
  Schema.Struct<Struct.Simplify<Readonly<Struct.Assign<Fields, typeof PayloadErrors>>>>
>

/**
 * A mutation payload: `null` when nothing matched the ids, else the payload with its validation messages.
 * @param {Schema.Struct.Fields} fields The payload's own fields.
 * @returns {Schema.NullOr} The payload schema.
 */
const Payload = <Fields extends Schema.Struct.Fields>(fields: Fields): PayloadSchema<Fields> =>
  Schema.NullOr(Schema.Struct(fields).mapFields(Struct.assign(PayloadErrors)))

/**
 * Hardcover mutations report validation problems in the payload (`error` or
 * `errors`) with HTTP 200. Fails with those messages, else returns the payload.
 * @param {object} options The payload and the mutation field it came from.
 * @param {object | null} options.value The decoded payload.
 * @param {string} options.field The mutation's root field, for the not-found message.
 * @returns {Effect.Effect} The payload.
 */
const payload = <Value extends Readonly<{ error?: string | null; errors?: ReadonlyArray<string | null> | null }>>(
  options: Readonly<{ value: Value | null; field: string }>,
): Effect.Effect<Value, HardcoverError> => {
  const { field, value } = options
  if (Predicate.isNull(value)) {
    return HardcoverError.make({ kind: "not_found", message: `Hardcover returned nothing for ${field}; check the ids.` })
  }
  const listed = pipe(value.errors ?? [], Arr.filter(Predicate.isNotNull))
  const messages = pipe(Option.toArray(Option.fromNullishOr(value.error)), Arr.appendAll(listed), Arr.filter(Str.isNonEmpty))
  return Arr.isReadonlyArrayNonEmpty(messages)
    ? HardcoverError.make({ kind: "invalid", message: `Hardcover: ${Arr.join(messages, "; ")}` })
    : Effect.succeed(value)
}

/**
 * The first row of a lookup, or `not_found`.
 * @param {object} options The rows and what they are.
 * @param {ReadonlyArray} options.rows The rows Hardcover returned.
 * @param {string} options.what What was looked up, for the error message.
 * @returns {Effect.Effect} The first row.
 */
const first = <Row>(options: Readonly<{ rows: ReadonlyArray<Row>; what: string }>): Effect.Effect<Row, HardcoverError> =>
  Option.match(Arr.head(options.rows), {
    onNone: () => HardcoverError.make({ kind: "not_found", message: `No ${options.what} found.` }),
    onSome: Effect.succeed,
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { DateString, first, Id, Json, JsonList, Limit, Offset, Payload, payload, Privacy, privacyId, run, Status, STATUS_IDS, STATUS_NAMES }
/**
 * Application module, not a public API.
 * @internal
 */
export type { PrivacyName }
