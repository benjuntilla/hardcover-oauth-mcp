/** Handlers for schema discovery and raw GraphQL. */
import { Array as Arr, Effect, Option, Order, Record as Rec, Schema, String as Str, Struct, pipe } from "effect"
import { CatalogEdit, Delete, DescribeType, FindOperations, Mutate, Query } from "./generic-tools.ts"
import { OPERATIONS, SCHEMA_SOURCE, TYPES, namedType } from "#src/hardcover/api-index.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import MiniSearch from "minisearch"
import { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { matchSorter } from "match-sorter"
import { runDocument } from "./generic-run.ts"

const DescribeParams = Schema.Struct({ name: Schema.String })
const FindParams = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["query", "mutation"])),
  limit: Schema.optionalKey(Schema.Int),
  search: Schema.optionalKey(Schema.String),
})
const DocumentParams = Schema.Struct({
  operationName: Schema.optionalKey(Schema.String),
  query: Schema.String,
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

const DEFAULT_MATCHES = 25
const SIMILAR_LIMIT = 10
const NAME_BOOST = 3
const MIN_PREFIX_LENGTH = 3
const MIN_FUZZY_LENGTH = 5
const FUZZINESS = 0.2

/** Words too common in requests to tell operations apart. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "i",
  "in",
  "is",
  "it",
  "my",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
])

/** Request verbs, mapped to the ones Hardcover's operation names use. */
const SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  add: ["insert"],
  change: ["update"],
  create: ["insert"],
  edit: ["update"],
  remove: ["delete"],
}

interface FoundOperation {
  readonly allowed: boolean
  readonly args: string
  readonly description?: string
  readonly kind: "query" | "mutation"
  readonly name: string
  readonly returns: string
  readonly scopes: ReadonlyArray<string>
}

interface IndexedOperation {
  readonly name: string
  readonly returns: string
}

interface TypeName {
  readonly key: string
  readonly name: string
}

/**
 * Splits snake_case, camelCase, and wrapped type names like `[user_books!]!` into lowercase words, dropping stopwords.
 * @param {string} text An operation name, return type, or search.
 * @returns {Array<string>} The words.
 */
const tokenize = (text: string): Array<string> =>
  pipe(
    text,
    Str.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gv, " "),
    Str.toLowerCase,
    Str.split(/[^a-z0-9]+/v),
    Arr.filter((word: string) => Str.isNonEmpty(word) && !STOPWORDS.has(word)),
  )

/**
 * Folds plurals, so "list books" also finds `insert_list_book`.
 * @param {string} word A lowercase word.
 * @returns {string} The word without its plural ending.
 */
const singular = (word: string): string => pipe(word, Str.replace(/(?<=\w{2})ies$/v, "y"), Str.replace(/(?<=\w{3})(?<!s)s$/v, ""))

/** Ranks by BM25 over operation names and return types; descriptions are mostly boilerplate that repeats the name. */
const searchIndex = Effect.sync(() => {
  const index = new MiniSearch<IndexedOperation>({
    fields: ["name", "returns"],
    idField: "name",
    processTerm: singular,
    searchOptions: {
      boost: { name: NAME_BOOST },
      fuzzy: (term): number | false => term.length >= MIN_FUZZY_LENGTH && FUZZINESS,
      prefix: (term): boolean => term.length >= MIN_PREFIX_LENGTH,
      processTerm: (term): Array<string> => [singular(term), ...(SYNONYMS[term] ?? [])],
    },
    tokenize,
  })
  index.addAll(
    pipe(
      Rec.toEntries(OPERATIONS),
      Arr.map(([name, info]) => ({ name, returns: info.returns })),
    ),
  )
  return index
}).pipe(Effect.cached, Effect.runSync)

/**
 * Operation names matching a search, best first; all of them, in schema order, for an empty one.
 * @param {string | undefined} search The words to match.
 * @param {"query" | "mutation" | undefined} kind Only operations of this kind, if given.
 * @returns {Effect.Effect<ReadonlyArray<string>>} The matching names.
 */
const rankedNames = (search: string | undefined, kind: "query" | "mutation" | undefined): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* rankNames() {
    const index = yield* searchIndex
    const text = search ?? ""
    const query = Arr.isReadonlyArrayEmpty(tokenize(text)) ? MiniSearch.wildcard : text
    const names = pipe(
      index.search(query),
      Arr.map((result) => String(result.id)),
    )
    return Option.match(Option.fromNullishOr(kind), {
      onNone: () => names,
      onSome: (only) =>
        pipe(
          names,
          Arr.filter((name) => OPERATIONS[name]?.kind === only),
        ),
    })
  })

const described = (found: FoundOperation): FoundOperation =>
  Option.match(Option.fromNullishOr(found.description), {
    onNone: () => Struct.omit(found, ["description"]),
    onSome: () => found,
  })

const foundOperation = (name: string, info: (typeof OPERATIONS)[string], scopes: ReadonlySet<string>): FoundOperation => {
  const base = {
    allowed:
      Arr.isReadonlyArrayEmpty(info.scopes) ||
      pipe(
        info.scopes,
        Arr.some((scope) => scopes.has(scope)),
      ),
    args: info.args,
    kind: info.kind,
    name,
    returns: info.returns,
    scopes: info.scopes,
  }
  const description = Option.fromNullishOr(info.description)
  return described(Option.isSome(description) ? Struct.assign(base, { description: description.value }) : base)
}

/**
 * A name as its singular words run together, so `UserBook`, `user_books`, and `userbook` compare equal.
 * @param {string} name A type name, or a guess at one.
 * @returns {string} The comparable form.
 */
const nameKey = (name: string): string => pipe(tokenize(name), Arr.map(singular), Arr.join(""))

const TYPE_NAMES: ReadonlyArray<TypeName> = pipe(
  Rec.keys(TYPES),
  Arr.map((name) => ({ key: nameKey(name), name })),
)

const shorterName: Order.Order<TypeName> = Order.combine(
  Order.mapInput(Order.Number, (type: TypeName) => type.name.length),
  Order.mapInput(Order.String, (type: TypeName) => type.name),
)

const longerKeyFirst: Order.Order<TypeName> = Order.flip(Order.mapInput(Order.Number, (type: TypeName) => type.key.length))

/**
 * Types named like a missing one, best first: the same words, then names that start with them, contain them, or
 * nearly spell them, shortest first within each. Failing that, types named inside it, such as `books` in `books_by_pk`.
 * @param {string} key The missing type's name.
 * @returns {ReadonlyArray<string>} Up to ten names.
 */
const similarTypes = (key: string): ReadonlyArray<string> => {
  const wanted = nameKey(key)
  if (Str.isEmpty(wanted)) {
    return []
  }
  const close = matchSorter(TYPE_NAMES, wanted, { baseSort: (self, that) => shorterName(self.item, that.item), keys: ["key"] })
  const found = Arr.isArrayNonEmpty(close)
    ? close
    : pipe(
        TYPE_NAMES,
        Arr.filter((type) => Str.isNonEmpty(type.key) && Str.includes(type.key)(wanted)),
        Arr.sortBy(longerKeyFirst),
      )
  return pipe(
    found,
    Arr.take(SIMILAR_LIMIT),
    Arr.map((type) => type.name),
  )
}

const missingType = (key: string): HardcoverError => {
  const close = similarTypes(key)
  const similar = Arr.isReadonlyArrayNonEmpty(close) ? ` Similar: ${pipe(close, Arr.join(", "))}.` : ""
  return HardcoverError.make({ kind: "not_found", message: `No type named ${key}.${similar}` })
}

const run = (
  expect: "query" | "mutation",
  allow: "reads" | "writes" | "deletes" | "catalog",
): ((
  params: typeof DocumentParams.Type,
) => Effect.Effect<Readonly<{ data: Readonly<Record<string, unknown>> }>, HardcoverError, Session>) =>
  Effect.fn(function* runOperation(params: typeof DocumentParams.Type) {
    return yield* runDocument({ allow, expect, params })
  })

const genericHandlers = {
  hardcover_catalog_edit: run("mutation", "catalog"),
  hardcover_delete: run("mutation", "deletes"),
  hardcover_describe_type: Effect.fn(function* describeType(params: typeof DescribeParams.Type) {
    const key = namedType(params.name.trim())
    const type = Option.fromNullishOr(TYPES[key])
    if (Option.isNone(type)) {
      return yield* missingType(key)
    }
    return { name: key, type: type.value }
  }),
  hardcover_find_operations: Effect.fn(function* findOperations(params: typeof FindParams.Type) {
    const session = yield* Session
    const { kind, limit = DEFAULT_MATCHES, search } = params
    const names = yield* rankedNames(search, kind)
    return {
      operations: pipe(
        names,
        Arr.take(limit),
        Arr.flatMap((name) =>
          pipe(
            Rec.get(OPERATIONS, name),
            Option.map((info) => foundOperation(name, info, session.scopes)),
            Option.toArray,
          ),
        ),
      ),
      source: SCHEMA_SOURCE,
      total: Arr.length(names),
    }
  }),
  hardcover_mutate: run("mutation", "writes"),
  hardcover_query: run("query", "reads"),
}

const GraphQLToolkit = Toolkit.make(FindOperations, DescribeType, Query, Mutate, Delete, CatalogEdit)
const GraphQLToolkitLive = GraphQLToolkit.toLayer(genericHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { GraphQLToolkit, GraphQLToolkitLive }
