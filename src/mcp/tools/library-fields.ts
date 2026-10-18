/** GraphQL selections and decoded shapes for library entries and reading sessions. */
import { Payload } from "./common.ts"
import { Schema } from "effect"

const READ_FIELDS = "id started_at finished_at paused_at progress progress_pages progress_seconds edition_id"
const ENTRY_FIELDS = `id book_id edition_id status_id rating privacy_setting_id owned starred has_review
  review_markdown review_has_spoilers reviewed_at private_notes recommended_by recommended_for
  date_added first_started_reading_date first_read_date last_read_date read_count updated_at
  book { id title slug pages audio_seconds contributions(limit: 3) { author { name } } }
  edition { id title pages audio_seconds reading_format_id }`

const NullableInt = Schema.NullOr(Schema.Int)
const NullableString = Schema.NullOr(Schema.String)

const Lengths = Schema.Struct({
  audio_seconds: NullableInt,
  pages: NullableInt,
})

const EditionLengths = Schema.Struct({
  audio_seconds: NullableInt,
  id: Schema.Int,
  pages: NullableInt,
})

const ReadWithEdition = Schema.Struct({
  edition: Schema.optionalKey(Schema.NullOr(EditionLengths)),
  edition_id: NullableInt,
  finished_at: NullableString,
  id: Schema.Int,
  progress_pages: NullableInt,
  progress_seconds: NullableInt,
  started_at: NullableString,
})

const EntryRow = Schema.Struct({
  book: Schema.optionalKey(Lengths),
  edition: Schema.optionalKey(Schema.NullOr(EditionLengths)),
  edition_id: NullableInt,
  id: Schema.Int,
  owned: Schema.optionalKey(Schema.Boolean),
  status_id: NullableInt,
  user_book_reads: Schema.optionalKey(Schema.Array(ReadWithEdition)),
})

const BookBody = Schema.Struct({
  id: NullableInt,
  user_book: Schema.Unknown,
})

const ReadBody = Schema.Struct({
  id: NullableInt,
  user_book_read: Schema.Unknown,
})

const BookPayload = Payload(BookBody.fields)
const ReadPayload = Payload(ReadBody.fields)

const DeletedBook = Schema.Struct({
  id: NullableInt,
})

const DeletedReadBody = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(Schema.String)),
  id: NullableInt,
})

const DeletedRead = Payload(DeletedReadBody.fields)

const OwnedList = Schema.Struct({
  list_books: Schema.Array(Schema.Struct({ id: Schema.Int })),
})

const OwnedLists = Schema.Struct({
  lists: Schema.Array(OwnedList),
})

const RowCount = Schema.Struct({ count: Schema.Int })

const LibraryPage = Schema.Struct({
  user_books: Schema.Array(Schema.Unknown),
  user_books_aggregate: Schema.Struct({ aggregate: Schema.NullOr(RowCount) }),
})

const BookRows = Schema.Struct({
  user_books: Schema.Array(Schema.Unknown),
})

const EntryRows = Schema.Struct({
  user_books: Schema.Array(EntryRow),
})

const OwnedRead = Schema.Struct({
  edition_id: NullableInt,
  finished_at: NullableString,
  id: Schema.Int,
  progress_pages: NullableInt,
  progress_seconds: NullableInt,
  started_at: NullableString,
  user_book: Schema.Struct({ user_id: Schema.Int }),
})

const ReadLookup = Schema.Struct({
  user_book_reads_by_pk: Schema.NullOr(OwnedRead),
})

const OwnedRow = Schema.Struct({ id: Schema.optionalKey(NullableInt) })

const OwnedChange = Schema.Struct({
  edition_owned: Schema.NullOr(OwnedRow),
})

type Entry = typeof EntryRow.Type
type Read = typeof ReadWithEdition.Type

export {
  BookPayload,
  BookRows,
  DeletedBook,
  DeletedRead,
  ENTRY_FIELDS,
  EditionLengths,
  EntryRows,
  LibraryPage,
  OwnedChange,
  OwnedLists,
  READ_FIELDS,
  ReadLookup,
  ReadPayload,
}
export type { Entry, Read }
