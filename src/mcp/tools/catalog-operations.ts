/** The GraphQL operations behind the catalog tools. */
import { AUTHOR_FIELDS, BOOK_FIELDS, EDITION_FIELDS, SERIES_FIELDS } from "#src/mcp/tools/catalog-fields.ts"
import { JsonList, run } from "#src/mcp/tools/common.ts"
import { GraphQL } from "effect/graphql"
import { Schema } from "effect"
import { SearchPayload } from "#src/mcp/tools/catalog-search.ts"

const CONTRIBUTIONS_PREVIEW = 2
const ISBN_EDITION_LIMIT = 10

const Rows = Schema.Array(Schema.Unknown)
/** A lookup by slug; each query fills in its own root field. */
const SlugData = Schema.Struct({
  authors: Schema.optionalKey(Rows),
  books: Schema.optionalKey(Rows),
  series: Schema.optionalKey(Rows),
})
/** A lookup by id; each query fills in its own root field. */
const ByPkData = Schema.Struct({
  authors_by_pk: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  books_by_pk: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
  series_by_pk: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
})
const SearchData = Schema.Struct({ search: Schema.NullOr(SearchPayload) })
const EditionsData = Schema.Struct({ editions: JsonList })
/** Hardcover's `[Int]`: its items may be null too. */
const TrendingIds = Schema.Array(Schema.NullOr(Schema.Finite))
const TrendingPayload = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ids: Schema.optionalKey(TrendingIds),
})
const TrendingData = Schema.Struct({ books_trending: Schema.NullOr(TrendingPayload) })
/** A book row: the id is decoded for ranking, the other fields pass through to the tool result. */
const TrendingBook = Schema.StructWithRest(Schema.Struct({ id: Schema.Finite }), [Schema.Record(Schema.String, Schema.Unknown)])
const TrendingBooks = Schema.Struct({ books: Schema.Array(TrendingBook) })

/** Hardcover's `TrendingDuration` enum. */
const TrendingDuration = Schema.Literals(["all", "month", "one_year", "three_month", "week"])

const searchHardcover = run(
  GraphQL.query("Search", {
    document: `query Search($query: String!, $type: String!, $perPage: Int!, $page: Int!) {
        search(query: $query, query_type: $type, per_page: $perPage, page: $page) { ids results error }
      }`,
    result: SearchData,
    variables: { page: Schema.Int, perPage: Schema.Int, query: Schema.String, type: Schema.String },
  }),
)

const bookById = run(
  GraphQL.query("Book", {
    document: `query Book($id: Int!) { books_by_pk(id: $id) { ${BOOK_FIELDS} } }`,
    result: ByPkData,
    variables: { id: Schema.Int },
  }),
)

const bookBySlug = run(
  GraphQL.query("Book", {
    document: `query Book($slug: String!) { books(where: {slug: {_eq: $slug}}, limit: 1) { ${BOOK_FIELDS} } }`,
    result: SlugData,
    variables: { slug: Schema.String },
  }),
)

const authorById = run(
  GraphQL.query("Author", {
    document: `query Author($id: Int!, $limit: Int!) { authors_by_pk(id: $id) { ${AUTHOR_FIELDS} } }`,
    result: ByPkData,
    variables: { id: Schema.Int, limit: Schema.Int },
  }),
)

const authorBySlug = run(
  GraphQL.query("Author", {
    document: `query Author($slug: String!, $limit: Int!) { authors(where: {slug: {_eq: $slug}}, limit: 1) { ${AUTHOR_FIELDS} } }`,
    result: SlugData,
    variables: { limit: Schema.Int, slug: Schema.String },
  }),
)

const seriesById = run(
  GraphQL.query("Series", {
    document: `query Series($id: Int!) { series_by_pk(id: $id) { ${SERIES_FIELDS} } }`,
    result: ByPkData,
    variables: { id: Schema.Int },
  }),
)

const seriesBySlug = run(
  GraphQL.query("Series", {
    document: `query Series($slug: String!) { series(where: {slug: {_eq: $slug}}, limit: 1) { ${SERIES_FIELDS} } }`,
    result: SlugData,
    variables: { slug: Schema.String },
  }),
)

const editionsWithIsbn = run(
  GraphQL.query("EditionByIsbn", {
    document: `query EditionByIsbn($isbn: String!) {
          editions(where: {_or: [{isbn_13: {_eq: $isbn}}, {isbn_10: {_eq: $isbn}}]}, limit: ${ISBN_EDITION_LIMIT}) { ${EDITION_FIELDS} book { id title slug } }
        }`,
    result: EditionsData,
    variables: { isbn: Schema.String },
  }),
)

const editionsOfBook = run(
  GraphQL.query("Editions", {
    document: `query Editions($bookId: Int!, $limit: Int!, $offset: Int!) {
        editions(where: {book_id: {_eq: $bookId}}, order_by: [{users_count: desc}, {id: asc}], limit: $limit, offset: $offset) { ${EDITION_FIELDS} }
      }`,
    result: EditionsData,
    variables: { bookId: Schema.Int, limit: Schema.Int, offset: Schema.Int },
  }),
)

const trendingIds = run(
  GraphQL.query("Trending", {
    document: `query Trending($period: TrendingDuration!, $limit: Int!) { books_trending(duration: $period, limit: $limit) { ids error } }`,
    result: TrendingData,
    variables: { limit: Schema.Int, period: TrendingDuration },
  }),
)

const booksByIds = run(
  GraphQL.query("TrendingBooks", {
    document: `query TrendingBooks($ids: [Int!]!) {
        books(where: {id: {_in: $ids}}) { id title slug release_year rating users_count contributions(limit: ${CONTRIBUTIONS_PREVIEW}) { author { name } } }
      }`,
    result: TrendingBooks,
    variables: { ids: Schema.Array(Schema.Int) },
  }),
)

type ByPk = typeof ByPkData.Type
type BySlug = typeof SlugData.Type

/**
 * Application module, not a public API.
 * @internal
 */
export {
  authorById,
  authorBySlug,
  bookById,
  bookBySlug,
  booksByIds,
  editionsOfBook,
  editionsWithIsbn,
  searchHardcover,
  seriesById,
  seriesBySlug,
  trendingIds,
}
/**
 * Application module, not a public API.
 * @internal
 */
export type { ByPk, BySlug }
