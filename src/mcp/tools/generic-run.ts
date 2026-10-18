/** Routes a caller-written GraphQL document to the tool that is allowed to run it. */
import { Array as Arr, Effect, Option, Schema, String as Str, Struct, pipe } from "effect"
import type { GuardResult, Inspection } from "#src/hardcover/guard.ts"
import { getOperationAST, parse } from "graphql"
import { inspect, missingScopes } from "#src/hardcover/guard.ts"
import { GraphQL } from "effect/graphql"
import type { GraphQLParams } from "./generic-tools.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { OPERATIONS } from "#src/hardcover/api-index.ts"
import { Session } from "#src/mcp/session.ts"
import { run } from "./common.ts"

const CATALOG_PREFIX = "write:catalog"
const DELETE_PREFIX = "delete_"

type Allowance = "reads" | "writes" | "deletes" | "catalog"
type OperationKind = "query" | "mutation"

/**
 * Whether a root field edits the shared catalog.
 * @param {string} name The root field name.
 * @returns {boolean} True when one of its scopes is a catalog write scope.
 */
const isCatalogOperation = (name: string): boolean =>
  pipe(
    Option.fromNullishOr(OPERATIONS[name]),
    Option.exists((info) => pipe(info.scopes, Arr.some(Str.startsWith(CATALOG_PREFIX)))),
  )

const wrongTool = (message: string): HardcoverError => HardcoverError.make({ kind: "invalid", message })

const catalogMisrouted = (allow: Allowance, fields: ReadonlyArray<string>, catalog: ReadonlyArray<string>): Option.Option<string> => {
  if (allow === "catalog" && Arr.length(catalog) !== Arr.length(fields)) {
    return Option.some("hardcover_catalog_edit only runs catalog mutations; use hardcover_mutate or hardcover_delete.")
  }
  if ((allow === "writes" || allow === "deletes") && Arr.isReadonlyArrayNonEmpty(catalog)) {
    return Option.some(`${pipe(catalog, Arr.join(", "))}: use hardcover_catalog_edit for catalog changes.`)
  }
  return Option.none()
}

const deleteMisrouted = (allow: Allowance, fields: ReadonlyArray<string>, deleting: ReadonlyArray<string>): Option.Option<string> => {
  if (allow === "writes" && Arr.isReadonlyArrayNonEmpty(deleting)) {
    return Option.some(`${pipe(deleting, Arr.join(", "))}: use hardcover_delete for deletions.`)
  }
  if (allow === "deletes" && Arr.length(deleting) !== Arr.length(fields)) {
    return Option.some("hardcover_delete only runs delete_* fields; use hardcover_mutate.")
  }
  return Option.none()
}

const isRejected = (result: GuardResult): result is Extract<GuardResult, { readonly ok: false }> => !result.ok

const misroutedMessage = (allow: Allowance, inspection: Inspection): Option.Option<string> => {
  const fields = inspection.rootFields
  const catalog = pipe(fields, Arr.filter(isCatalogOperation))
  const deleting = pipe(
    fields,
    Arr.filter((name) => Str.startsWith(DELETE_PREFIX)(name) && !isCatalogOperation(name)),
  )
  return Option.firstSomeOf([catalogMisrouted(allow, fields, catalog), deleteMisrouted(allow, fields, deleting)])
}

const forbidden = (missing: ReadonlyArray<string>): HardcoverError =>
  HardcoverError.make({
    kind: "forbidden",
    message: `This connection lacks permission: ${pipe(missing, Arr.join("; "))}. Reconnect the MCP server and grant those scopes (librarian scopes also need the role).`,
  })

const GraphQLData = Schema.Record(Schema.String, Schema.Unknown)
/** The variables of any document. */
const AnyVariables = Schema.Record(Schema.String, Schema.Unknown)
/** Any `data`; `runDocument` narrows it to an object. */
const AnyData = Schema.Unknown
const NO_VARIABLES: Readonly<Record<string, unknown>> = {}

type AnyOperation = GraphQL.Operation<OperationKind, string, typeof AnyVariables, typeof AnyData>

const parsed = Option.liftThrowable(parse)

/**
 * The name of the operation the guard chose: the one called `operationName`, or the document's only one.
 * @param {typeof GraphQLParams.Type} params The caller's document and operation name, already accepted by the guard.
 * @returns {Option.Option<string>} The operation's own name, or none when it is anonymous.
 */
const chosenName = (params: typeof GraphQLParams.Type): Option.Option<string> =>
  pipe(
    parsed(params.query),
    Option.flatMapNullishOr((document) => getOperationAST(document, params.operationName)),
    Option.flatMapNullishOr((operation) => operation.name?.value),
  )

/**
 * The caller's document as an operation of its own name and kind.
 * @param {object} options The document, its name, and its kind.
 * @param {string} options.document The caller's document.
 * @param {OperationKind} options.kind Whether it is a query or a mutation.
 * @param {string} options.name The document's own name for the operation.
 * @returns {AnyOperation} The operation.
 */
const operationOf = (options: Readonly<{ document: string; kind: OperationKind; name: string }>): AnyOperation => {
  const fields = { document: options.document, result: AnyData, variables: AnyVariables }
  return options.kind === "mutation" ? GraphQL.mutation(options.name, fields) : GraphQL.query(options.name, fields)
}

/**
 * Sends an accepted document. A named operation runs through `run` under its own name. An anonymous one is sent
 * without an operation name, which `run` always sends and Hasura refuses for an anonymous operation.
 * @param {object} options The document's kind and the caller's document.
 * @param {OperationKind} options.kind Whether the document is a query or a mutation.
 * @param {typeof GraphQLParams.Type} options.params The caller's document and variables.
 * @returns {Effect.Effect<unknown, HardcoverError, Session>} The GraphQL `data`.
 */
const sendDocument = (
  options: Readonly<{ kind: OperationKind; params: typeof GraphQLParams.Type }>,
): Effect.Effect<unknown, HardcoverError, Session> => {
  const { kind, params } = options
  return Option.match(chosenName(params), {
    onNone: () => Session.use((session) => session.graphql(Struct.pick(params, ["query", "variables"]), { mutation: kind === "mutation" })),
    onSome: (name) => run(operationOf({ document: params.query, kind, name }))(params.variables ?? NO_VARIABLES),
  })
}

const checked = (
  options: Readonly<{ allow: Allowance; expect: OperationKind; params: typeof GraphQLParams.Type }>,
): Effect.Effect<Inspection, HardcoverError, Session> =>
  Effect.gen(function* checkDocument() {
    const { allow, expect, params } = options
    const result = inspect(params.query, { expect, operationName: params.operationName, variables: params.variables })
    if (isRejected(result)) {
      return yield* wrongTool(result.message)
    }
    const misrouted = misroutedMessage(allow, result.inspection)
    if (Option.isSome(misrouted)) {
      return yield* wrongTool(misrouted.value)
    }
    const session = yield* Session
    const missing = missingScopes(result.inspection, session.scopes)
    return Arr.isReadonlyArrayNonEmpty(missing) ? yield* forbidden(missing) : result.inspection
  })

/**
 * Checks the document, then runs it when this tool is the one allowed to.
 * @param {object} options The expected kind, the allowed field class, and the caller's document.
 * @param {OperationKind} options.expect Whether the document must be a query or a mutation.
 * @param {Allowance} options.allow Which class of root field this tool accepts.
 * @param {typeof GraphQLParams.Type} options.params The caller's document and variables.
 * @returns {Effect.Effect} The GraphQL `data`.
 */
const runDocument = (
  options: Readonly<{ allow: Allowance; expect: OperationKind; params: typeof GraphQLParams.Type }>,
): Effect.Effect<Readonly<{ data: Readonly<Record<string, unknown>> }>, HardcoverError, Session> =>
  Effect.gen(function* runCheckedDocument() {
    yield* checked(options)
    const raw = yield* sendDocument({ kind: options.expect, params: options.params })
    // The client already turns a response without a `data` object into a defect; this only narrows the type.
    const data = yield* Schema.decodeUnknownEffect(GraphQLData)(raw).pipe(
      Effect.catchTag("SchemaError", () => Effect.die("Hardcover's response data was not an object")),
    )
    return { data }
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { runDocument }
