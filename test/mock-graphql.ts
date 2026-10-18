/**
 * Answers a GraphQL document from the mock's per-root-field handlers. `me`
 * always returns the configured user; an unknown field is Hardcover's
 * "not found in type" error.
 */
import { Array as Arr, Effect, Option, Predicate, Record as Rec, Schema, String as Str, pipe } from "effect"
import { Kind, parse } from "graphql"
import { OK, UNAUTHORIZED, json } from "#test/mock-http.ts"
import type { FieldNode } from "graphql"

const BEARER_PATTERN = /^Bearer /v
const ME_FIELD = "me"

interface GraphHandler {
  readonly run: (variables: Readonly<Record<string, unknown>>, query: string) => unknown
}

interface MockUser {
  readonly id: number
  readonly librarian_roles: ReadonlyArray<string>
  readonly name: string
  readonly pro: boolean
  readonly username: string
}

interface GraphCall {
  readonly query: string
  readonly token: string
  readonly variables: Readonly<Record<string, unknown>>
}

interface RecordedCalls {
  readonly append: (call: GraphCall) => void
}

interface Answering {
  readonly handlers: Readonly<Record<string, GraphHandler>>
  readonly query: string
  readonly user: MockUser
  readonly variables: Readonly<Record<string, unknown>>
}

const GraphBody = Schema.Struct({
  query: Schema.String,
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

const rootFields = (query: string): ReadonlyArray<FieldNode> =>
  pipe(
    parse(query).definitions,
    Arr.findFirst((definition) => definition.kind === Kind.OPERATION_DEFINITION),
    Option.map((operation) => operation.selectionSet.selections),
    Option.map(Arr.filter((selection) => selection.kind === Kind.FIELD)),
    Option.getOrElse((): ReadonlyArray<FieldNode> => []),
  )

const answered = (answering: Answering, field: FieldNode): readonly [string, unknown] => {
  const name = field.name.value
  const key = field.alias?.value ?? name
  if (name === ME_FIELD) {
    return [key, [answering.user]]
  }
  return [key, answering.handlers[name]?.run(answering.variables, answering.query)]
}

const unknownField = (answering: Answering, fields: ReadonlyArray<FieldNode>): Option.Option<string> =>
  pipe(
    fields,
    Arr.map((field) => field.name.value),
    Arr.findFirst((name) => name !== ME_FIELD && Predicate.isUndefined(answering.handlers[name])),
  )

const document = (answering: Answering): Response => {
  const fields = rootFields(answering.query)
  const missing = unknownField(answering, fields)
  if (Option.isSome(missing)) {
    return json({ body: { errors: [{ message: `field '${missing.value}' not found in type: 'query_root'` }] }, status: OK })
  }
  const data = pipe(
    fields,
    Arr.map((field) => answered(answering, field)),
    Rec.fromEntries,
  )
  return json({ body: { data }, status: OK })
}

const bearer = (header: string | null): string => pipe(header ?? "", Str.replace(BEARER_PATTERN, ""))

const readJson = (request: Request): Promise<unknown> => request.json()

/**
 * Answers one GraphQL request, as Hardcover would.
 * @param {object} input The mock's state and the request.
 * @param {ReadonlyMap<string, object>} input.accessTokens The live access tokens.
 * @param {RecordedCalls} input.calls Where to record the call.
 * @param {Readonly<Record<string, GraphHandler>>} input.handlers Root field name to handler.
 * @param {Request} input.request The GraphQL request.
 * @param {MockUser} input.user What `me` returns.
 * @returns {Effect.Effect<Response>} The GraphQL response; a malformed request is a defect (a 500).
 */
const answerGraphql = (input: {
  readonly accessTokens: ReadonlyMap<string, { readonly scope: string }>
  readonly calls: RecordedCalls
  readonly handlers: Readonly<Record<string, GraphHandler>>
  readonly request: Request
  readonly user: MockUser
}): Effect.Effect<Response> =>
  Effect.gen(function* answerDocument() {
    const token = bearer(input.request.headers.get("authorization"))
    if (!input.accessTokens.has(token)) {
      return json({ body: { error: "invalid_token" }, status: UNAUTHORIZED })
    }
    const body = yield* Effect.promise(() => readJson(input.request)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GraphBody)),
      Effect.orDie,
    )
    const variables = body.variables ?? {}
    input.calls.append({ query: body.query, token, variables })
    return document({ handlers: input.handlers, query: body.query, user: input.user, variables })
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { answerGraphql }
export type { GraphCall, GraphHandler, MockUser, RecordedCalls }
