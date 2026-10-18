/**
 * A fake Hardcover client that validates each GraphQL document and its
 * variables against Hardcover's published schema, records it, then answers
 * every root field with its fixture.
 */
import { Array as Arr, Effect, Option, Record as Rec, Ref, pipe } from "effect"
import type { DocumentNode, FieldNode, GraphQLSchema, OperationDefinitionNode } from "graphql"
import { Kind, buildSchema, getVariableValues, parse, validate } from "graphql"
import type { ExecuteGraphQL } from "#src/hardcover/client.ts"
import type { GraphQLRequest } from "#src/hardcover/graphql.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { fixture } from "#test/tools-fixtures.ts"

interface GraphQLCall {
  readonly query: string
  readonly variables: Readonly<Record<string, unknown>>
}

interface FakeHardcover {
  /** Every request since the last `clear`, valid or not, oldest first. */
  readonly calls: Effect.Effect<ReadonlyArray<GraphQLCall>>
  readonly clear: Effect.Effect<void>
  readonly graphql: ExecuteGraphQL
}

const SCHEMA_FILE = new URL("fixtures/hardcover-schema.graphql", import.meta.url)

/** Hardcover's published schema, from the fixture `scripts/sync-schema.ts` keeps current. */
const loadSchema: Effect.Effect<GraphQLSchema> = Effect.promise(() => Bun.file(SCHEMA_FILE).text()).pipe(
  Effect.map((sdl) => buildSchema(sdl, { assumeValidSDL: true })),
)

const isOperation = (definition: { readonly kind: string }): definition is OperationDefinitionNode =>
  definition.kind === Kind.OPERATION_DEFINITION

const isField = (selection: { readonly kind: string }): selection is FieldNode => selection.kind === Kind.FIELD

const invalid = (request: GraphQLRequest, problems: ReadonlyArray<string>): HardcoverError =>
  HardcoverError.make({ kind: "invalid", message: `Schema validation failed:\n${pipe(problems, Arr.join("\n"))}\n${request.query}` })

interface Parsed {
  readonly document: DocumentNode
  readonly operation: OperationDefinitionNode
}

const parsed = (request: GraphQLRequest): Effect.Effect<Parsed, HardcoverError> =>
  Effect.try({ catch: (error) => invalid(request, [String(error)]), try: () => parse(request.query) }).pipe(
    Effect.flatMap((document) =>
      pipe(
        document.definitions,
        Arr.findFirst(isOperation),
        Option.match({
          onNone: () => Effect.fail(invalid(request, ["No operation in the document."])),
          onSome: (operation) => Effect.succeed({ document, operation }),
        }),
      ),
    ),
  )

interface Check {
  readonly mutation: boolean
  readonly request: GraphQLRequest
  readonly schema: GraphQLSchema
  readonly source: Parsed
}

/**
 * What Hardcover would reject, plus what the real client would get wrong: an
 * `operationName` that isn't the document's (Hasura refuses it) and a document
 * sent as the wrong kind (mutations must never be retried).
 * @param {Check} check The request, its parsed document, how it was sent, and the schema.
 * @returns {ReadonlyArray<string>} The problems, or none.
 */
const problemsWith = (check: Check): ReadonlyArray<string> => {
  const { mutation, request, schema, source } = check
  const variables = getVariableValues(schema, source.operation.variableDefinitions ?? [], request.variables ?? {})
  const documentName = Option.fromNullishOr(source.operation.name?.value)
  const misnamed = pipe(
    Option.fromNullishOr(request.operationName),
    Option.filter((sent) => !Option.contains(documentName, sent)),
    Option.map(
      (sent) => `operationName ${sent} doesn't match the document's ${Option.getOrElse(documentName, () => "anonymous")} operation.`,
    ),
    Option.toArray,
  )
  const sentAs = mutation ? "mutation" : "query"
  const miskinded =
    sentAs === source.operation.operation ? [] : [`Sent as a ${sentAs} but the document is a ${source.operation.operation}.`]
  return pipe(
    [...validate(schema, source.document), ...(variables.errors ?? [])],
    Arr.map((error) => error.message),
    Arr.appendAll(misnamed),
    Arr.appendAll(miskinded),
  )
}

const answer = (operation: OperationDefinitionNode, variables: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  pipe(
    operation.selectionSet.selections,
    Arr.filter(isField),
    Arr.map((field) => [field.alias?.value ?? field.name.value, fixture({ field: field.name.value, variables })] as const),
    Rec.fromEntries,
  )

const validated = (schema: GraphQLSchema, request: GraphQLRequest, mutation: boolean): Effect.Effect<unknown, HardcoverError> =>
  Effect.gen(function* validateRequest() {
    const source = yield* parsed(request)
    const problems = problemsWith({ mutation, request, schema, source })
    if (Arr.isReadonlyArrayNonEmpty(problems)) {
      return yield* invalid(request, problems)
    }
    return answer(source.operation, request.variables ?? {})
  })

/** A fake client with an empty log, validating against Hardcover's schema. */
const makeFakeHardcover: Effect.Effect<FakeHardcover> = Effect.gen(function* makeFakeHardcover() {
  const schema = yield* loadSchema
  const log = yield* Ref.make<ReadonlyArray<GraphQLCall>>([])
  return {
    calls: Ref.get(log),
    clear: Ref.set(log, []),
    graphql: (request, options) =>
      Ref.update(log, Arr.append({ query: request.query, variables: request.variables ?? {} })).pipe(
        Effect.andThen(validated(schema, request, options?.mutation ?? false)),
      ),
  }
})

export { makeFakeHardcover }
export type { GraphQLCall }
