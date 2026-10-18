/**
 * Checks a caller-written GraphQL document before it is sent to Hardcover, so the model gets a precise,
 * actionable error instead of spending rate limit on a request Hardcover will refuse: one operation of the
 * expected kind, only root fields available to API tokens, at most 10 top-level fields (the smallest burst
 * limit), none of the disabled text operators, and the scopes every root field, gated column, and gated argument needs.
 */
import { Array as Arr, Function, Option, Predicate, Result, pipe } from "effect"
import type { DocumentNode, FragmentDefinitionNode, OperationDefinitionNode } from "graphql"
import { GATED_ARGUMENTS, GATED_COLUMNS, OPERATIONS } from "#src/hardcover/api-index.ts"
import { Kind, parse } from "graphql"
import { collectKeys, publicRootFields, visitNames } from "#src/hardcover/guard-fields.ts"

/** Documented as disabled for API tokens. */
const DISABLED_OPERATORS: ReadonlySet<string> = new Set([
  "_ilike",
  "_iregex",
  "_like",
  "_nilike",
  "_niregex",
  "_nlike",
  "_nregex",
  "_nsimilar",
  "_regex",
  "_similar",
])

/** Each top-level field costs one rate-limit token; Free accounts burst to 10. */
const MAX_TOP_LEVEL_FIELDS = 10
const NO_FIELDS = 0
const EMPTY_SCOPE_LIST = 0
const GRAPHQL_TOKEN_LIMIT = 5000
const DATA_FIRST_ARITY = 2
interface ScopeRequirement {
  readonly anyOf: ReadonlyArray<string>
  readonly reason: string
}

interface Inspection {
  readonly operation: "query" | "mutation"
  readonly rootFields: ReadonlyArray<string>
  /** Each entry is satisfied by any one of its scopes. */
  readonly scopeRequirements: ReadonlyArray<ScopeRequirement>
}

interface InspectOptions {
  readonly expect: "query" | "mutation"
  readonly operationName?: string | undefined
  readonly variables?: unknown
}

interface AcceptedInput {
  readonly operation: "query" | "mutation"
  readonly rootFields: ReadonlyArray<string>
  readonly selected: ReadonlySet<string>
  readonly uniqueRoots: ReadonlySet<string>
  readonly usedKeys: ReadonlySet<string>
}

type GuardResult = { readonly inspection: Inspection; readonly ok: true } | { readonly message: string; readonly ok: false }

type OperationKind = OperationDefinitionNode["operation"]

const rejected = (message: string): GuardResult => ({ message, ok: false })

const syntaxMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isOperation = (definition: { readonly kind: string }): definition is OperationDefinitionNode =>
  definition.kind === Kind.OPERATION_DEFINITION

const isFragment = (definition: { readonly kind: string }): definition is FragmentDefinitionNode =>
  definition.kind === Kind.FRAGMENT_DEFINITION

const SINGLE_OPERATION = 1
const NO_OPERATIONS = 0

const byName = (operations: ReadonlyArray<OperationDefinitionNode>, operationName: string): Option.Option<OperationDefinitionNode> =>
  pipe(
    operations,
    Arr.findFirst((operation) => operation.name?.value === operationName),
  )

const onlyOperation = (operations: ReadonlyArray<OperationDefinitionNode>): Option.Option<OperationDefinitionNode> =>
  operations.length === SINGLE_OPERATION ? Option.fromNullishOr(operations[NO_OPERATIONS]) : Option.none()

const chosenOperation = (
  operations: ReadonlyArray<OperationDefinitionNode>,
  operationName: string | undefined,
): Option.Option<OperationDefinitionNode> =>
  Predicate.isNotUndefined(operationName) ? byName(operations, operationName) : onlyOperation(operations)

const missingOperationMessage = (operations: ReadonlyArray<OperationDefinitionNode>): string =>
  operations.length === NO_OPERATIONS ? "The document has no operation." : "Send exactly one operation (or name it with operationName)."

const kindMismatch = (operation: OperationKind, expect: "query" | "mutation"): Option.Option<string> => {
  if (operation === expect) {
    return Option.none()
  }
  if (operation === "subscription") {
    return Option.some("Subscriptions are not supported.")
  }
  return Option.some(
    expect === "query"
      ? "This is a mutation; use hardcover_mutate (or hardcover_delete for deletions)."
      : "This is a query; use hardcover_query.",
  )
}

const fieldCountMessage = (count: number): Option.Option<string> => {
  if (count === NO_FIELDS) {
    return Option.some("The operation selects no fields.")
  }
  if (count > MAX_TOP_LEVEL_FIELDS) {
    return Option.some(`${count} top-level fields; Hardcover allows at most ${MAX_TOP_LEVEL_FIELDS} per request. Split it up.`)
  }
  return Option.none()
}

const unavailableField = (name: string, operation: "query" | "mutation"): Option.Option<string> => {
  const info = OPERATIONS[name]
  if (Predicate.isUndefined(info) || info.kind !== operation) {
    return Option.some(`"${name}" is not a ${operation} available to Hardcover API tokens. Use hardcover_find_operations to look up names.`)
  }
  return Option.none()
}

const firstUnavailable = (names: ReadonlySet<string>, operation: "query" | "mutation"): Option.Option<string> =>
  pipe(
    Arr.fromIterable(names),
    Arr.map((name) => unavailableField(name, operation)),
    Arr.filterMap((message) => (Option.isSome(message) ? Result.succeed(message.value) : Result.failVoid)),
    Arr.head,
  )

const requirementFor = (reason: string, scopes: ReadonlyArray<string> | undefined): Option.Option<ScopeRequirement> =>
  Predicate.isUndefined(scopes) || scopes.length === EMPTY_SCOPE_LIST ? Option.none() : Option.some({ anyOf: scopes, reason })

const rootRequirement = (name: string): Option.Option<ScopeRequirement> => {
  const info = OPERATIONS[name]
  return Predicate.isUndefined(info) ? Option.none() : requirementFor(name, info.scopes)
}

const disabledOperators = (usedKeys: ReadonlySet<string>): ReadonlyArray<string> =>
  pipe(
    Arr.fromIterable(usedKeys),
    Arr.filter((key) => DISABLED_OPERATORS.has(key)),
  )

const gatedRequirements = (
  names: Iterable<string>,
  gates: ReadonlyMap<string, ReadonlyArray<string>>,
  label: (name: string) => string,
): ReadonlyArray<ScopeRequirement> =>
  pipe(
    Arr.fromIterable(names),
    Arr.map((name) => requirementFor(label(name), gates.get(name))),
    Arr.getSomes,
  )

const argumentRequirements = (operation: "query" | "mutation", usedKeys: ReadonlySet<string>): ReadonlyArray<ScopeRequirement> =>
  operation === "mutation" ? gatedRequirements(usedKeys, GATED_ARGUMENTS, (key) => `argument ${key}`) : []

const scopeRequirements = (input: AcceptedInput): ReadonlyArray<ScopeRequirement> =>
  pipe(
    Arr.fromIterable(input.uniqueRoots),
    Arr.map((name) => rootRequirement(name)),
    Arr.getSomes,
    Arr.appendAll(gatedRequirements(input.selected, GATED_COLUMNS, (column) => `field ${column}`)),
    Arr.appendAll(argumentRequirements(input.operation, input.usedKeys)),
  )

const accepted = (input: AcceptedInput): GuardResult => ({
  inspection: { operation: input.operation, rootFields: input.rootFields, scopeRequirements: scopeRequirements(input) },
  ok: true,
})

const fragmentMap = (document: DocumentNode): Map<string, FragmentDefinitionNode> =>
  new Map(
    pipe(
      document.definitions,
      Arr.filter(isFragment),
      Arr.map((fragment) => [fragment.name.value, fragment] as const),
    ),
  )

const rejectIfSome = (message: Option.Option<string>): Option.Option<GuardResult> => pipe(message, Option.map(rejected))

const disabledMessage = (usedKeys: ReadonlySet<string>): Option.Option<string> => {
  const disabled = disabledOperators(usedKeys)
  return Arr.isReadonlyArrayNonEmpty(disabled)
    ? Option.some(
        `Hardcover disables ${pipe(disabled, Arr.join(", "))} for API tokens. Use _eq/_in, or the search operation for text search.`,
      )
    : Option.none()
}

const finishInspection = (
  operation: OperationDefinitionNode,
  rootFields: ReadonlyArray<string>,
  names: ReturnType<typeof visitNames>,
): GuardResult => {
  const uniqueRoots = new Set(rootFields)
  if (operation.operation === "subscription") {
    return rejected("Subscriptions are not supported.")
  }
  const unavailable = firstUnavailable(uniqueRoots, operation.operation)
  if (Option.isSome(unavailable)) {
    return rejected(unavailable.value)
  }
  const disabled = rejectIfSome(disabledMessage(names.usedKeys))
  if (Option.isSome(disabled)) {
    return disabled.value
  }
  return accepted({
    operation: operation.operation === "mutation" ? "mutation" : "query",
    rootFields,
    selected: names.selected,
    uniqueRoots,
    usedKeys: names.usedKeys,
  })
}

const selectOperation = (document: DocumentNode, options: InspectOptions): GuardResult | OperationDefinitionNode => {
  const operations = pipe(document.definitions, Arr.filter(isOperation))
  const operation = chosenOperation(operations, options.operationName)
  if (Option.isNone(operation)) {
    return rejected(missingOperationMessage(operations))
  }
  const mismatch = rejectIfSome(kindMismatch(operation.value.operation, options.expect))
  return Option.isSome(mismatch) ? mismatch.value : operation.value
}

const isGuardResult = (value: GuardResult | OperationDefinitionNode | DocumentNode): value is GuardResult => "ok" in value

const inspectOperation = (document: DocumentNode, operation: OperationDefinitionNode, options: InspectOptions): GuardResult => {
  const rootFields = publicRootFields({ fragments: fragmentMap(document), operation })
  const countMessage = rejectIfSome(fieldCountMessage(rootFields.length))
  if (Option.isSome(countMessage)) {
    return countMessage.value
  }
  const names = visitNames(document)
  return finishInspection(operation, rootFields, {
    selected: names.selected,
    usedKeys: collectKeys({ keys: names.usedKeys, value: options.variables }),
  })
}

const parseDocument = (query: string): GuardResult | DocumentNode => {
  try {
    return parse(query, { maxTokens: GRAPHQL_TOKEN_LIMIT, noLocation: true })
  } catch (error) {
    return rejected(`GraphQL syntax error: ${syntaxMessage(error)}`)
  }
}

const inspectDocument = (query: string, options: InspectOptions): GuardResult => {
  const parsed = parseDocument(query)
  if (isGuardResult(parsed)) {
    return parsed
  }
  const operation = selectOperation(parsed, options)
  return isGuardResult(operation) ? operation : inspectOperation(parsed, operation, options)
}

/**
 * Checks a caller-written GraphQL document before it is sent to Hardcover.
 * @param {string} query The GraphQL document.
 * @param {InspectOptions} options Expected operation kind, optional operation name, and variables.
 * @returns {GuardResult} The inspection, or a message naming what to fix.
 */
const inspect: {
  (options: Readonly<InspectOptions>): (query: string) => GuardResult
  (query: string, options: Readonly<InspectOptions>): GuardResult
} = Function.dual(DATA_FIRST_ARITY, (query: string, options: Readonly<InspectOptions>): GuardResult => inspectDocument(query, options))

const unmet = (requirement: ScopeRequirement, granted: ReadonlySet<string>): boolean =>
  !pipe(
    requirement.anyOf,
    Arr.some((scope) => granted.has(scope)),
  )

/**
 * Requirements the granted scopes don't meet, as human-readable lines.
 * @param {Inspection} inspection Result of a successful `inspect` call.
 * @param {ReadonlySet<string>} granted Scopes on the connection.
 * @returns {Array<string>} One line per unmet requirement.
 */
const missingScopes: {
  (granted: ReadonlySet<string>): (inspection: Inspection) => Array<string>
  (inspection: Inspection, granted: ReadonlySet<string>): Array<string>
} = Function.dual(DATA_FIRST_ARITY, (inspection: Inspection, granted: ReadonlySet<string>): Array<string> =>
  pipe(
    inspection.scopeRequirements,
    Arr.filter((requirement) => unmet(requirement, granted)),
    Arr.map((requirement) => `${requirement.reason} needs ${pipe(requirement.anyOf, Arr.join(" or "))}`),
  ),
)

export type { GuardResult, Inspection }
export { inspect, missingScopes }
