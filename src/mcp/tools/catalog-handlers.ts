/** Handlers for the catalog tools, through the SDK's books, authors, series, and search resources. */
import { Array as Arr, Effect, Option, Predicate, String as Str, Struct, pipe } from "effect"
import { CreateVibe, ListVibes, vibeHandlers } from "./vibes.ts"
import { DEFAULT_AUTHOR_BOOKS, DEFAULT_EDITIONS, DEFAULT_PER_PAGE, DEFAULT_SIMILAR, DEFAULT_TRENDING, MIN_PAGE } from "./catalog-fields.ts"
import { GetAuthor, GetBook, GetEditions, GetSeries, Search, Similar, Trending } from "./catalog-tools.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Toolkit } from "effect/ai"
import { call } from "./common.ts"

const FIRST_PAGE = MIN_PAGE
const FIRST_OFFSET = 0
const ISBN_SEPARATOR = "-"
const BOOK_URL = "https://hardcover.app/books"
const EMPTY = ""

const cleanIsbn = (isbn: string): string => pipe(isbn, Str.replaceAll(ISBN_SEPARATOR, EMPTY), Str.toUpperCase)

const BOTH = 2
const NONE = 0

/**
 * Requires exactly one of an id or a slug.
 * @param {number | undefined} id The numeric id.
 * @param {string | undefined} slug The slug.
 * @param {string} what What is being looked up.
 * @returns {Effect.Effect<void, HardcoverError>} Nothing, or why both or neither were passed.
 */
const oneOf = (id: number | undefined, slug: string | undefined, what: string): Effect.Effect<void, HardcoverError> => {
  const given = pipe([id, slug], Arr.filter(Predicate.isNotUndefined))
  if (given.length === BOTH) {
    return Effect.fail(HardcoverError.make({ kind: "invalid", message: `Pass ${what} id or slug, not both.` }))
  }
  if (given.length === NONE) {
    return Effect.fail(HardcoverError.make({ kind: "invalid", message: `Pass a ${what} id or slug.` }))
  }
  return Effect.void
}

interface SearchPage {
  readonly page: number
  readonly perPage: number
}

interface SearchAnswer {
  readonly found: number
  readonly hits: ReadonlyArray<unknown>
  readonly ids: ReadonlyArray<number>
}

type SearchCall = ReturnType<typeof call<SearchAnswer>>

const answered = (results: {
  readonly found: number
  readonly hits: ReadonlyArray<unknown>
  readonly ids: ReadonlyArray<number>
}): SearchAnswer => ({
  found: results.found,
  hits: results.hits,
  ids: results.ids,
})

const peopleSearch = (type: string, query: string, options: SearchPage): SearchCall => {
  if (type === "author") {
    return call((hardcover) => hardcover.client.search.authors(query, options).then(answered))
  }
  if (type === "character") {
    return call((hardcover) => hardcover.client.search.characters(query, options).then(answered))
  }
  if (type === "user") {
    return call((hardcover) => hardcover.client.search.users(query, options).then(answered))
  }
  return call((hardcover) => hardcover.client.search.publishers(query, options).then(answered))
}

const catalogSearch = (type: string, query: string, options: SearchPage): SearchCall => {
  if (type === "series") {
    return call((hardcover) => hardcover.client.search.series(query, options).then(answered))
  }
  if (type === "list") {
    return call((hardcover) => hardcover.client.search.lists(query, options).then(answered))
  }
  if (type === "prompt") {
    return call((hardcover) => hardcover.client.search.prompts(query, options).then(answered))
  }
  return call((hardcover) => hardcover.client.search.books(query, options).then(answered))
}

const searched = (type: string, query: string, options: SearchPage): SearchCall => {
  const people = type === "author" || type === "character" || type === "user" || type === "publisher"
  return people ? peopleSearch(type, query, options) : catalogSearch(type, query, options)
}

const search = Effect.fn(function* searchCatalog(params: typeof Search.parametersSchema.Type) {
  const type = params.type ?? "book"
  const options = { page: params.page ?? FIRST_PAGE, perPage: params.perPage ?? DEFAULT_PER_PAGE }
  const results = yield* searched(type, params.query, options)
  return { found: results.found, hits: results.hits, ids: results.ids, type }
})

const getBook = Effect.fn(function* getBookDetails(params: typeof GetBook.parametersSchema.Type) {
  yield* oneOf(params.id, params.slug, "book")
  const book = yield* call((hardcover) =>
    Predicate.isUndefined(params.id) ? hardcover.client.books.getBySlug(params.slug ?? EMPTY) : hardcover.client.books.get(params.id),
  )
  if (Predicate.isNull(book)) {
    return yield* HardcoverError.make({ kind: "not_found", message: "No book found." })
  }
  return { book, url: `${BOOK_URL}/${book.slug}` }
})

const getEditions = Effect.fn(function* getBookEditions(params: typeof GetEditions.parametersSchema.Type) {
  if (Predicate.isNotUndefined(params.isbn)) {
    const editions = yield* call((hardcover) => hardcover.client.books.findByIsbn([cleanIsbn(params.isbn ?? EMPTY)]))
    return { editions }
  }
  if (Predicate.isUndefined(params.bookId)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Pass bookId or isbn." })
  }
  const page = yield* call((hardcover) =>
    hardcover.client.books.editions(params.bookId ?? NONE, {
      limit: params.limit ?? DEFAULT_EDITIONS,
      offset: params.offset ?? FIRST_OFFSET,
    }),
  )
  return { editions: page.items }
})

const getAuthor = Effect.fn(function* getAuthorDetails(params: typeof GetAuthor.parametersSchema.Type) {
  yield* oneOf(params.id, params.slug, "author")
  const author = yield* call((hardcover) =>
    Predicate.isUndefined(params.id) ? hardcover.client.authors.getBySlug(params.slug ?? EMPTY) : hardcover.client.authors.get(params.id),
  )
  if (Predicate.isNull(author)) {
    return yield* HardcoverError.make({ kind: "not_found", message: "No author found." })
  }
  const books = yield* call((hardcover) => hardcover.client.authors.books(author.id, { limit: params.booksLimit ?? DEFAULT_AUTHOR_BOOKS }))
  return { author: Struct.assign(author, { books: books.items }) }
})

const getSeries = Effect.fn(function* getSeriesDetails(params: typeof GetSeries.parametersSchema.Type) {
  yield* oneOf(params.id, params.slug, "series")
  const series = yield* call((hardcover) =>
    Predicate.isUndefined(params.id) ? hardcover.client.series.getBySlug(params.slug ?? EMPTY) : hardcover.client.series.get(params.id),
  )
  if (Predicate.isNull(series)) {
    return yield* HardcoverError.make({ kind: "not_found", message: "No series found." })
  }
  const books = yield* call((hardcover) => hardcover.client.series.books(series.id))
  return { series: Struct.assign(series, { books: books.items }) }
})

const trending = Effect.fn(function* trendingBooks(params: typeof Trending.parametersSchema.Type) {
  const page = yield* call((hardcover) =>
    hardcover.client.books.trending({ duration: params.period ?? "month", limit: params.limit ?? DEFAULT_TRENDING }),
  )
  return { books: page.items }
})

const similar = Effect.fn(function* similarBooks(params: typeof Similar.parametersSchema.Type) {
  const page = yield* call((hardcover) =>
    hardcover.client.books.similar(params.bookId, { limit: params.limit ?? DEFAULT_SIMILAR, offset: params.offset ?? FIRST_OFFSET }),
  )
  return {
    books: page.items,
    built: Option.isSome(Option.fromNullishOr(page.updatedAt)),
    hasMore: page.hasMore,
    updatedAt: page.updatedAt,
  }
})

const catalogHandlers = {
  hardcover_get_author: getAuthor,
  hardcover_get_book: getBook,
  hardcover_get_editions: getEditions,
  hardcover_get_series: getSeries,
  hardcover_search: search,
  hardcover_similar_books: similar,
  hardcover_trending_books: trending,
}

const DiscoveryToolkit = Toolkit.make(Search, GetBook, GetEditions, GetAuthor, GetSeries, Trending, Similar, ListVibes, CreateVibe)
const DiscoveryToolkitLive = DiscoveryToolkit.toLayer(Struct.assign(catalogHandlers, vibeHandlers))

/**
 * Application module, not a public API.
 * @internal
 */
export { DiscoveryToolkit, DiscoveryToolkitLive }
