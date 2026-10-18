/** Catalog tool definitions. Scope: read:catalog. */
import {
  DEFAULT_AUTHOR_BOOKS,
  DEFAULT_EDITIONS,
  DEFAULT_PER_PAGE,
  DEFAULT_TRENDING,
  MAX_AUTHOR_BOOKS,
  MAX_EDITIONS,
  MAX_PER_PAGE,
  MAX_TRENDING,
  MIN_PAGE,
} from "./catalog-fields.ts"
import { Id, Json, JsonList, Limit, Offset } from "./common.ts"
import { SEARCH_TYPES } from "./catalog-search.ts"
import { Schema } from "effect"
import { hardcoverTool } from "#src/mcp/define.ts"

const TRENDING_PERIODS = ["week", "month", "three_month", "one_year", "all"] as const
const SearchType = Schema.Literals(SEARCH_TYPES).annotate({ description: "What to search (default book)." })
const TrendingPeriod = Schema.Literals(TRENDING_PERIODS).annotate({ description: "Default month." })
const ISBN_PATTERN = /^[0-9Xx\-]{10,17}$/v

const BookId = Id("Book id.")
const AuthorId = Id("Author id.")
const SeriesId = Id("Series id.")
const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_PAGE))
const Page = Schema.optionalKey(PageNumber)
const Slug = Schema.optionalKey(Schema.NonEmptyString)
const BookSlugText = Schema.NonEmptyString.annotate({ description: "Book slug from its hardcover.app URL." })
const BookSlug = Schema.optionalKey(BookSlugText)
const IsbnText = Schema.String.check(Schema.isPattern(ISBN_PATTERN)).annotate({ description: "ISBN-10 or ISBN-13." })
const Isbn = Schema.optionalKey(IsbnText)

const Search = hardcoverTool({
  description:
    "Full-text search of Hardcover's catalog and community: books (by title, ISBN, series, or author), authors, series, lists, " +
    "prompts, users, characters, or publishers. Returns ranked hits with ids to use in other tools.",
  kind: "read",
  name: "hardcover_search",
  parameters: Schema.Struct({
    page: Page,
    perPage: Limit({ fallback: DEFAULT_PER_PAGE, max: MAX_PER_PAGE }),
    query: Schema.NonEmptyString.annotate({ description: "What to search for (a title, ISBN, name…)." }),
    type: Schema.optionalKey(SearchType),
  }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ found: Schema.optionalKey(Json), hits: JsonList, ids: JsonList, type: Schema.String }),
  title: "Search Hardcover",
})

const GetBook = hardcoverTool({
  description:
    "Details of a book by id or slug: description, release, pages, ratings, contributors, series, and default editions. " +
    "If canonical_id is set, the book was merged into that one.",
  kind: "read",
  name: "hardcover_get_book",
  parameters: Schema.Struct({
    id: Schema.optionalKey(BookId),
    slug: BookSlug,
  }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ book: Json, url: Schema.String }),
  title: "Get a book",
})

const GetEditions = hardcoverTool({
  description:
    "Editions of a book (most read first) with ISBNs, format, pages or audio length, publisher, and language; or the editions " +
    "matching an ISBN-10/13. Edition ids are what progress, ownership, and list entries use.",
  kind: "read",
  name: "hardcover_get_editions",
  parameters: Schema.Struct({
    bookId: Schema.optionalKey(BookId),
    isbn: Isbn,
    limit: Limit({ fallback: DEFAULT_EDITIONS, max: MAX_EDITIONS }),
    offset: Offset,
  }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ editions: JsonList }),
  title: "Get editions",
})

const GetAuthor = hardcoverTool({
  description: "An author by id or slug, with bio and their most-read books.",
  kind: "read",
  name: "hardcover_get_author",
  parameters: Schema.Struct({
    booksLimit: Limit({ fallback: DEFAULT_AUTHOR_BOOKS, max: MAX_AUTHOR_BOOKS }),
    id: Schema.optionalKey(AuthorId),
    slug: Slug,
  }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ author: Json }),
  title: "Get an author",
})

const GetSeries = hardcoverTool({
  description: "A series by id or slug with its books in reading order (one book per position, compilations and partial books left out).",
  kind: "read",
  name: "hardcover_get_series",
  parameters: Schema.Struct({ id: Schema.optionalKey(SeriesId), slug: Slug }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ series: Json }),
  title: "Get a series",
})

const Trending = hardcoverTool({
  description: "Books trending on Hardcover over a period. Costs two requests of the Hardcover rate limit.",
  kind: "read",
  name: "hardcover_trending_books",
  parameters: Schema.Struct({
    limit: Limit({ fallback: DEFAULT_TRENDING, max: MAX_TRENDING }),
    period: Schema.optionalKey(TrendingPeriod),
  }),
  scopes: ["read:catalog"],
  success: Schema.Struct({ books: JsonList }),
  title: "Trending books",
})

/**
 * Application module, not a public API.
 * @internal
 */
export { GetAuthor, GetBook, GetEditions, GetSeries, Search, Trending }
