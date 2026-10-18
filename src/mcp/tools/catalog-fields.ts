/** GraphQL field lists and page-size defaults for the catalog tools. */

const DEFAULT_AUTHOR_BOOKS = 20
const DEFAULT_EDITIONS = 25
const DEFAULT_PER_PAGE = 10
const DEFAULT_TRENDING = 20
const MAX_AUTHOR_BOOKS = 100
const MAX_EDITIONS = 100
const MAX_PER_PAGE = 50
const MAX_TRENDING = 50
const MIN_PAGE = 1

const BOOK_FIELDS = `
  id title subtitle slug headline description pages audio_seconds release_date release_year
  rating ratings_count reviews_count users_count users_read_count lists_count editions_count
  compilation book_category_id literary_type_id canonical_id alternative_titles cached_tags
  image { url }
  contributions { contribution author { id name slug } }
  book_series { position details featured series { id name slug books_count primary_books_count is_completed } }
  default_physical_edition_id default_ebook_edition_id default_audio_edition_id`

const EDITION_FIELDS = `id title subtitle isbn_10 isbn_13 asin pages audio_seconds release_date edition_format physical_format
      reading_format_id reading_format { format } publisher { id name } language { language code2 } users_count book_id`

const AUTHOR_FIELDS = `id name slug bio books_count born_year death_year location alternate_names canonical_id image { url }
      contributions(where: {contributable_type: {_eq: "Book"}}, order_by: {book: {users_count: desc}}, limit: $limit) {
        contribution book { id title slug release_year rating users_count }
      }`

const SERIES_FIELDS = `id name slug description books_count primary_books_count is_completed canonical_id author { id name slug }
      book_series(
        where: {compilation: {_eq: false}, book: {canonical_id: {_is_null: true}}}
        distinct_on: position
        order_by: [{position: asc}, {book: {users_count: desc}}]
      ) { position details featured book { id title slug release_year users_count } }`

/**
 * Application module, not a public API.
 * @internal
 */
export {
  AUTHOR_FIELDS,
  BOOK_FIELDS,
  DEFAULT_AUTHOR_BOOKS,
  DEFAULT_EDITIONS,
  DEFAULT_PER_PAGE,
  DEFAULT_TRENDING,
  EDITION_FIELDS,
  MAX_AUTHOR_BOOKS,
  MAX_EDITIONS,
  MAX_PER_PAGE,
  MAX_TRENDING,
  MIN_PAGE,
  SERIES_FIELDS,
}
