/** Handlers for the catalog tools. */
import { Array as Arr, Effect, Option, Order, Predicate, String as Str, Struct, pipe } from "effect"
import { CreateVibe, ListVibes, vibeHandlers } from "./vibes.ts"
import { DEFAULT_AUTHOR_BOOKS, DEFAULT_EDITIONS, DEFAULT_PER_PAGE, DEFAULT_TRENDING, MIN_PAGE } from "./catalog-fields.ts"
import { GetAuthor, GetBook, GetEditions, GetSeries, Search, Trending } from "./catalog-tools.ts"
import {
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
} from "./catalog-operations.ts"
import { bookSlug, lookupByIdOrSlug } from "./catalog-lookup.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { SearchPayload } from "./catalog-search.ts"
import type { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { slimSearch } from "./catalog-search.ts"

const EMPTY_COUNT = 0
const FIRST_PAGE = MIN_PAGE
const ISBN_SEPARATOR = "-"
const MISSING_RANK = 0

interface RankedBook {
  readonly id: number
}

const cleanIsbn = (isbn: string): string => pipe(isbn, Str.replaceAll(ISBN_SEPARATOR, ""), Str.toUpperCase)

const editionsForIsbn = (isbn: string): Effect.Effect<Readonly<{ editions: ReadonlyArray<unknown> }>, HardcoverError, Session> =>
  Effect.gen(function* editionsByIsbn() {
    const data = yield* editionsWithIsbn({ isbn: cleanIsbn(isbn) })
    return { editions: data.editions }
  })

const editionsForBook = (
  bookId: number,
  limit: number,
  offset: number,
): Effect.Effect<Readonly<{ editions: ReadonlyArray<unknown> }>, HardcoverError, Session> =>
  Effect.gen(function* editionsByBook() {
    const data = yield* editionsOfBook({ bookId, limit, offset })
    return { editions: data.editions }
  })

const searchResult = (
  search: typeof SearchPayload.Type,
  type: (typeof Search.parametersSchema.Type)["type"],
): Effect.Effect<typeof Search.successSchema.Type, HardcoverError> => {
  if (Option.isSome(Option.fromNullishOr(search.error))) {
    return HardcoverError.make({ kind: "invalid", message: `Search failed: ${search.error}` })
  }
  const slimmed = slimSearch({ results: search.results, type: type ?? "book" })
  const base = { hits: slimmed.hits, ids: search.ids ?? [], type: type ?? "book" }
  return Effect.succeed(Option.isSome(slimmed.found) ? Struct.assign(base, { found: slimmed.found.value }) : base)
}

const rankOf = (order: ReadonlyMap<number, number>, id: number): number => order.get(id) ?? MISSING_RANK

const byTrendingRank = (order: ReadonlyMap<number, number>): Order.Order<RankedBook> =>
  Order.mapInput(Order.Number, (book: RankedBook) => rankOf(order, book.id))

const trendingBooks = (ids: ReadonlyArray<number>): Effect.Effect<ReadonlyArray<RankedBook>, HardcoverError, Session> =>
  Effect.gen(function* loadTrendingBooks() {
    if (Arr.isReadonlyArrayEmpty(ids)) {
      return []
    }
    const data = yield* booksByIds({ ids })
    const order = new Map(
      pipe(
        ids,
        Arr.map((id, index) => [id, index] as const),
      ),
    )
    return pipe(data.books, Arr.sortBy(byTrendingRank(order)))
  })

const catalogHandlers = {
  hardcover_get_author: Effect.fn(function* getAuthor(params: typeof GetAuthor.parametersSchema.Type) {
    const limit = params.booksLimit ?? DEFAULT_AUTHOR_BOOKS
    const author = yield* lookupByIdOrSlug({
      byId: (id) => authorById({ id, limit }),
      bySlug: (slug) => authorBySlug({ limit, slug }),
      idField: "authors_by_pk",
      missing: "author",
      params,
      slugField: "authors",
      what: "author",
    })
    return { author }
  }),

  hardcover_get_book: Effect.fn(function* getBook(params: typeof GetBook.parametersSchema.Type) {
    const book = yield* lookupByIdOrSlug({
      byId: (id) => bookById({ id }),
      bySlug: (slug) => bookBySlug({ slug }),
      idField: "books_by_pk",
      missing: "book",
      params,
      slugField: "books",
      what: "book",
    })
    const slug = yield* bookSlug(book)
    return { book, url: `https://hardcover.app/books/${slug}` }
  }),

  hardcover_get_editions: Effect.fn(function* getEditions(params: typeof GetEditions.parametersSchema.Type) {
    const { limit = DEFAULT_EDITIONS, offset = EMPTY_COUNT } = params
    const isbn = Option.fromNullishOr(params.isbn)
    if (Option.isSome(isbn)) {
      return yield* editionsForIsbn(isbn.value)
    }
    const bookId = Option.fromNullishOr(params.bookId)
    if (Option.isNone(bookId)) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Pass bookId or isbn." })
    }
    return yield* editionsForBook(bookId.value, limit, offset)
  }),

  hardcover_get_series: Effect.fn(function* getSeries(params: typeof GetSeries.parametersSchema.Type) {
    const series = yield* lookupByIdOrSlug({
      byId: (id) => seriesById({ id }),
      bySlug: (slug) => seriesBySlug({ slug }),
      idField: "series_by_pk",
      missing: "series",
      params,
      slugField: "series",
      what: "series",
    })
    return { series }
  }),

  hardcover_search: Effect.fn(function* searchCatalog(params: typeof Search.parametersSchema.Type) {
    const { page = FIRST_PAGE, perPage = DEFAULT_PER_PAGE, query, type = "book" } = params
    const data = yield* searchHardcover({ page, perPage, query, type })
    return yield* searchResult(data.search ?? {}, type)
  }),

  hardcover_trending_books: Effect.fn(function* trendingBooksHandler(params: typeof Trending.parametersSchema.Type) {
    const { limit = DEFAULT_TRENDING, period = "month" } = params
    const data = yield* trendingIds({ limit, period })
    const trending = data.books_trending
    if (Option.isSome(Option.fromNullishOr(trending?.error))) {
      return yield* HardcoverError.make({ kind: "unavailable", message: `Trending failed: ${trending?.error}` })
    }
    const ids = pipe(trending?.ids ?? [], Arr.filter(Predicate.isNotNull), Arr.take(limit))
    return { books: yield* trendingBooks(ids) }
  }),
}

/** Catalog lookups and the user's vibes (recommendation feeds). */
const DiscoveryToolkit = Toolkit.make(Search, GetBook, GetEditions, GetAuthor, GetSeries, Trending, ListVibes, CreateVibe)
const DiscoveryToolkitLive = DiscoveryToolkit.toLayer(Struct.assign(catalogHandlers, vibeHandlers))

/**
 * Application module, not a public API.
 * @internal
 */
export { DiscoveryToolkit, DiscoveryToolkitLive }
