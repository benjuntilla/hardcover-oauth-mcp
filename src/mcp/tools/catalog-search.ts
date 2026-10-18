/** Slims Typesense search hits down to the fields each result type needs. */
import { Array as Arr, Option, Predicate, Record as Rec, Schema, Struct, pipe } from "effect"

const SEARCH_TYPES = ["book", "author", "series", "list", "prompt", "user", "character", "publisher"] as const

type SearchType = (typeof SEARCH_TYPES)[number]

/** Fields kept from each Typesense search document, to keep results small. */
const SEARCH_FIELDS: Readonly<Record<SearchType, ReadonlyArray<string>>> = {
  author: ["id", "name", "books_count", "series_names", "slug"],
  book: [
    "id",
    "title",
    "subtitle",
    "author_names",
    "release_year",
    "pages",
    "rating",
    "ratings_count",
    "users_count",
    "series_names",
    "featured_series_position",
    "has_audiobook",
    "has_ebook",
    "slug",
  ],
  character: ["id", "name", "author_names", "books_count", "slug"],
  list: ["id", "name", "description", "books_count", "likes_count", "user", "slug"],
  prompt: ["id", "question", "answers_count", "users_count", "user", "slug"],
  publisher: ["id", "name", "editions_count", "slug"],
  series: ["id", "name", "author_name", "books_count", "primary_books_count", "readers_count", "slug"],
  user: ["id", "username", "name", "books_count", "followers_count", "pro", "flair", "location"],
}

const SearchHit = Schema.Struct({ document: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })
const SearchResults = Schema.Struct({
  found: Schema.optionalKey(Schema.Unknown),
  hits: Schema.Array(Schema.Unknown),
})
/** Hardcover's `[Int]`: its items may be null too. */
const SearchIds = Schema.Array(Schema.NullOr(Schema.Finite))
const SearchPayload = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ids: Schema.optionalKey(SearchIds),
  results: Schema.optionalKey(Schema.Unknown),
})

interface SlimmedSearch {
  readonly found: Option.Option<unknown>
  readonly hits: ReadonlyArray<unknown>
}

/** Typesense stores ids as strings, such as `"230671"`. */
const DocumentId = Schema.Union([Schema.Finite, Schema.FiniteFromString])

const documentId = (document: Readonly<Record<string, unknown>>): Option.Option<number> =>
  Schema.decodeUnknownOption(DocumentId)(document.id)

const pickedDocument = (document: Readonly<Record<string, unknown>>, keep: ReadonlyArray<string>): Readonly<Record<string, unknown>> =>
  pipe(
    keep,
    Arr.filter((key) => Rec.has(document, key)),
    Arr.map((key) => [key, document[key]] as const),
    Rec.fromEntries,
  )

const slimHit = (hit: unknown, keep: ReadonlyArray<string>): Readonly<Record<string, unknown>> => {
  const decoded = Schema.decodeUnknownOption(SearchHit)(hit)
  if (Option.isNone(decoded)) {
    return {}
  }
  const document = decoded.value.document ?? {}
  const picked = pickedDocument(document, keep)
  const id = documentId(document)
  return Option.isSome(id) ? Struct.assign(picked, { id: id.value }) : picked
}

const slimHits = (results: typeof SearchResults.Type, type: SearchType): SlimmedSearch => ({
  found: Option.fromNullishOr(results.found),
  hits: pipe(
    results.hits,
    Arr.map((hit) => slimHit(hit, SEARCH_FIELDS[type])),
  ),
})

const passthrough = (results: unknown): SlimmedSearch => ({
  found: Option.none(),
  hits: Predicate.isNullish(results) ? [] : [results],
})

/**
 * Keeps only the fields this result type needs, and always returns a numeric id.
 * A response that is not a Typesense hit list is passed through as one hit.
 * @param {object} options The raw results and the type that was searched.
 * @param {unknown} options.results The `results` field of a search payload.
 * @param {SearchType} options.type Which catalog type was searched.
 * @returns {SlimmedSearch} The found count, when present, and the slimmed hits.
 */
const slimSearch = (options: Readonly<{ results: unknown; type: SearchType }>): SlimmedSearch =>
  pipe(
    options.results,
    Schema.decodeUnknownOption(SearchResults),
    Option.match({ onNone: () => passthrough(options.results), onSome: (decoded) => slimHits(decoded, options.type) }),
  )

export { SEARCH_TYPES, SearchPayload, slimSearch }
