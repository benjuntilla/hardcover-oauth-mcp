/**
 * Schema discovery and raw GraphQL, for anything the specific tools don't cover.
 * Every document passes `inspect()` first (see hardcover/guard.ts).
 */
import { Array as Arr, Predicate, Schema, String as Str, pipe } from "effect"
import { Json, JsonList } from "./common.ts"
import { ALL_SCOPES } from "#src/hardcover/scopes.ts"
import { hardcoverTool } from "#src/mcp/define.ts"

const MAX_MATCHES = 100
const MIN_MATCHES = 1
const WRITE_PREFIX = "write:"
const CATALOG_PREFIX = "write:catalog"

const writeScopes = pipe(
  ALL_SCOPES,
  Arr.filter((info) => Str.startsWith(WRITE_PREFIX)(info.scope)),
  Arr.map((info) => info.scope),
)
const catalogScopes = pipe(writeScopes, Arr.filter(Str.startsWith(CATALOG_PREFIX)))
const otherWriteScopes = pipe(
  writeScopes,
  Arr.filter((scope) => Predicate.not(Str.startsWith(CATALOG_PREFIX))(scope)),
)

const MatchLimit = Schema.Int.check(Schema.isBetween({ maximum: MAX_MATCHES, minimum: MIN_MATCHES }))
const OperationKind = Schema.Literals(["query", "mutation"])
const SearchWords = Schema.String.annotate({ description: "Names or words, e.g. 'user_books', 'add book to list', 'goal'." })
const TypeName = Schema.String.annotate({ description: "Type name, e.g. user_books, UserBookUpdateInput." })
const GraphQLParams = Schema.Struct({
  operationName: Schema.optionalKey(Schema.String),
  query: Schema.String.annotate({
    description: "One GraphQL operation. Hasura syntax: where/order_by/limit/offset, _eq/_in/_gt etc.",
  }),
  variables: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown).annotate({ description: "Variables for the operation." })),
})
const DataResult = Schema.Struct({ data: Schema.Record(Schema.String, Schema.Unknown) })

const FindOperations = hardcoverTool({
  description:
    "Searches the Hardcover GraphQL root fields available to API tokens by name and return type, best matches first. " +
    "Returns each operation's arguments, return type, the scopes that allow it, and whether this connection has one. " +
    "Follow up with hardcover_describe_type for the fields of a type.",
  kind: "read",
  name: "hardcover_find_operations",
  parameters: Schema.Struct({
    kind: Schema.optionalKey(OperationKind),
    limit: Schema.optionalKey(MatchLimit),
    search: Schema.optionalKey(SearchWords),
  }),
  scopes: [],
  success: Schema.Struct({ operations: JsonList, source: Json, total: Schema.Int }),
  title: "Find Hardcover API operations",
})

const DescribeType = hardcoverTool({
  description:
    "Lists the fields (with argument and value types) of a Hardcover GraphQL object or input type, or the values of an enum. " +
    "Accepts wrapped names like [user_books!]!.",
  kind: "read",
  name: "hardcover_describe_type",
  parameters: Schema.Struct({ name: TypeName }),
  scopes: [],
  success: Schema.Struct({ name: Schema.String, type: Json }),
  title: "Describe a Hardcover GraphQL type",
})

const Query = hardcoverTool({
  description:
    "Runs a read-only GraphQL query against Hardcover. At most 10 top-level fields; text operators (_like, _ilike, _regex…) " +
    "are disabled, so use the search operation for text. Each top-level field costs one request of the account's Hardcover rate limit.",
  kind: "read",
  name: "hardcover_query",
  parameters: GraphQLParams,
  scopes: [],
  success: DataResult,
  title: "Run a Hardcover GraphQL query",
})

const Mutate = hardcoverTool({
  anyOf: otherWriteScopes,
  description:
    "Runs a GraphQL mutation (insert, update, upsert) on the user's own data. Not for deletions (hardcover_delete) or catalog " +
    "edits (hardcover_catalog_edit). Mutation payloads report problems in their own error/errors fields; select them. " +
    "Never retried automatically.",
  destructive: true,
  idempotent: false,
  kind: "update",
  name: "hardcover_mutate",
  parameters: GraphQLParams,
  scopes: [],
  success: DataResult,
  title: "Run a Hardcover GraphQL mutation",
})

const Delete = hardcoverTool({
  anyOf: otherWriteScopes,
  description: "Runs a GraphQL mutation whose top-level fields are all delete_* operations on the user's data. Deletions can't be undone.",
  kind: "delete",
  name: "hardcover_delete",
  parameters: GraphQLParams,
  scopes: [],
  success: DataResult,
  title: "Run a Hardcover GraphQL deletion",
})

const CatalogEdit = hardcoverTool({
  anyOf: catalogScopes,
  description:
    "Runs a catalog mutation: insert_book, insert_edition, update_book, update_edition, insert_author, update_author, " +
    "insert_serie, upsert_tags, book mappings, and the like (see hardcover_find_operations). Anyone can add new records and " +
    "fill empty fields (write:catalog:append). Changing existing data needs write:catalog:edit and a librarian role; book " +
    "mappings need write:catalog:map and the book_mapper role. Changes are public and affect every Hardcover user.",
  destructive: true,
  idempotent: false,
  kind: "update",
  name: "hardcover_catalog_edit",
  parameters: GraphQLParams,
  scopes: [],
  success: DataResult,
  title: "Add to or edit the Hardcover catalog",
})

/**
 * Application module, not a public API.
 * @internal
 */
export { CatalogEdit, Delete, DescribeType, FindOperations, GraphQLParams, Mutate, Query }
