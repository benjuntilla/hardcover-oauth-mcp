/** Typed access to `src/generated/hardcover-api.json` (regenerate with `mise run schema:sync`). */
import { Effect, Option, Schema } from "effect"
import index from "#root/src/generated/hardcover-api.json" with { type: "json" }

interface OperationInfo {
  readonly args: string
  readonly description?: string
  readonly kind: "query" | "mutation"
  readonly returns: string
  /** Any one of these scopes allows the operation. */
  readonly scopes: ReadonlyArray<string>
}

interface TypeInfo {
  readonly description?: string
  readonly fields?: ReadonlyArray<string>
  readonly kind: "object" | "input" | "enum" | "union" | "scalar"
  readonly types?: ReadonlyArray<string>
  readonly values?: ReadonlyArray<string>
}

interface ScopeEntry {
  readonly action: string | null
  readonly arguments: ReadonlyArray<string>
  readonly columns: ReadonlyArray<string>
  readonly description: string
  readonly implies: ReadonlyArray<string>
  readonly scope: string
}

interface SchemaSource {
  readonly ref: string
  readonly repository: string
}

const OperationInfoSchema = Schema.Struct({
  args: Schema.String,
  description: Schema.optionalKey(Schema.String),
  kind: Schema.Literals(["query", "mutation"]),
  returns: Schema.String,
  scopes: Schema.Array(Schema.String),
})

const TypeInfoSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Schema.String)),
  kind: Schema.Literals(["object", "input", "enum", "union", "scalar"]),
  types: Schema.optionalKey(Schema.Array(Schema.String)),
  values: Schema.optionalKey(Schema.Array(Schema.String)),
})

const ScopeEntrySchema = Schema.Struct({
  action: Schema.NullOr(Schema.String),
  arguments: Schema.Array(Schema.String),
  columns: Schema.Array(Schema.String),
  description: Schema.String,
  implies: Schema.Array(Schema.String),
  scope: Schema.String,
})

const IndexSchema = Schema.Struct({
  operations: Schema.Record(Schema.String, OperationInfoSchema),
  scopes: Schema.Array(ScopeEntrySchema),
  source: Schema.Struct({ ref: Schema.String, repository: Schema.String }),
  types: Schema.Record(Schema.String, TypeInfoSchema),
})

const readIndex = Effect.fn(function* readIndex() {
  return yield* Schema.decodeUnknownEffect(IndexSchema)(index)
})
const decoded = readIndex().pipe(Effect.runSync)
const OPERATIONS: Readonly<Record<string, OperationInfo>> = decoded.operations
const TYPES: Readonly<Record<string, TypeInfo>> = decoded.types
const SCOPE_ENTRIES: ReadonlyArray<ScopeEntry> = decoded.scopes
const SCHEMA_SOURCE: SchemaSource = decoded.source

const scopesByName = (pick: (entry: ScopeEntry) => ReadonlyArray<string>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const grouped = new Map<string, Array<string>>()
  for (const entry of SCOPE_ENTRIES) {
    for (const name of pick(entry)) {
      const current = Option.fromNullishOr(grouped.get(name))
      grouped.set(name, [...Option.getOrElse(current, () => []), entry.scope])
    }
  }
  return grouped
}

/** Columns only some scopes may select (e.g. `librarian_roles`), with the scopes that allow each. */
const GATED_COLUMNS: ReadonlyMap<string, ReadonlyArray<string>> = scopesByName((entry) => entry.columns)
/** Mutation arguments only some scopes may set (e.g. `review_markdown` needs `write:reviews`). */
const GATED_ARGUMENTS: ReadonlyMap<string, ReadonlyArray<string>> = scopesByName((entry) => entry.arguments)

const LIST_OPEN = "["
const LIST_CLOSE = "]"
const NON_NULL = "!"

/**
 * Strips list and non-null wrappers: `[user_books!]!` → `user_books`.
 * @param {string} type A GraphQL type reference, possibly wrapped in list and non-null markers.
 * @returns {string} The named type with wrappers removed.
 */
const namedType = (type: string): string => type.replaceAll(LIST_OPEN, "").replaceAll(LIST_CLOSE, "").replaceAll(NON_NULL, "")

export { GATED_ARGUMENTS, GATED_COLUMNS, OPERATIONS, SCHEMA_SOURCE, TYPES, namedType }
