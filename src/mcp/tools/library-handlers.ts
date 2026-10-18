/** Handlers for the library tools. */
import type {
  AddRead,
  DeleteRead,
  DeleteReview,
  GetEntry,
  ListLibrary,
  ListReviews,
  MarkFinished,
  RateBook,
  RemoveFromLibrary,
  SetOwned,
  SetStatus,
  UpdateEntry,
  UpdateProgress,
  UpdateRead,
  WriteReview,
} from "./library-tools.ts"
import { Array as Arr, Effect, Option, Predicate, Record as Rec, Schema, Struct, pipe } from "effect"
import type { EntryEdit, EntryOrderBy, ReadChanges } from "./library-operations.ts"
import { STATUS_IDS, payload, privacyId } from "./common.ts"
import {
  currentlyReadingRows,
  deleteUserBook,
  deleteUserBookRead,
  libraryRows,
  libraryRowsByStatus,
  reviewRows,
} from "./library-operations.ts"
import { findEntry, readById, requireEntry, upsertEntry, writes } from "./library-store.ts"
import { markFinished, recordProgress } from "./library-progress.ts"
import type { Entry } from "./library-fields.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { LibraryToolkit } from "./library-tools.ts"
import { Session } from "#src/mcp/session.ts"
import { setEditionOwned } from "./library-owned.ts"

const DEFAULT_LIBRARY_LIMIT = 25
const NO_ROWS = 0
const DEFAULT_OFFSET = 0
const DEFAULT_REVIEW_LIMIT = 10
const EMPTY_REVIEW = ""

const LIBRARY_SORT = {
  added: { date_added: "desc_nulls_last" },
  last_read: { last_read_date: "desc_nulls_last" },
  rating: { rating: "desc_nulls_last" },
  title: { book: { title: "asc" } },
  updated: { updated_at: "desc_nulls_last" },
} as const

const NEWEST_ID_FIRST: EntryOrderBy = { id: "desc" }

const EMPTY_REVIEW_SLATE = { document: { children: [], object: "document" } }

type LibrarySort = keyof typeof LIBRARY_SORT

const sortOf = (sort: LibrarySort | undefined): LibrarySort => sort ?? "updated"

const privacySetting = (privacy: "followers" | "private" | "public" | undefined): number | undefined =>
  Predicate.isUndefined(privacy) ? Option.getOrUndefined(Option.none()) : privacyId(privacy)

const listLibrary = Effect.fn(function* listLibraryBooks(params: typeof ListLibrary.parametersSchema.Type) {
  const { hcUserId } = yield* Session
  const { status } = params
  const page = {
    limit: params.limit ?? DEFAULT_LIBRARY_LIMIT,
    offset: params.offset ?? DEFAULT_OFFSET,
    orderBy: [LIBRARY_SORT[sortOf(params.sort)], NEWEST_ID_FIRST],
    userId: hcUserId,
  }
  const data = yield* Predicate.isUndefined(status)
    ? libraryRows(page)
    : libraryRowsByStatus(Struct.assign(page, { statusId: STATUS_IDS[status] }))
  return { books: pipe(data.user_books, Arr.map(writes.named)), total: data.user_books_aggregate.aggregate?.count ?? NO_ROWS }
})

const currentlyReading = Effect.fn(function* listCurrentlyReading() {
  const session = yield* Session
  const data = yield* currentlyReadingRows({ userId: session.hcUserId })
  return { books: data.user_books }
})

const listReviews = Effect.fn(function* listReviewedBooks(params: typeof ListReviews.parametersSchema.Type) {
  const session = yield* Session
  const data = yield* reviewRows({
    limit: params.limit ?? DEFAULT_REVIEW_LIMIT,
    offset: params.offset ?? DEFAULT_OFFSET,
    userId: session.hcUserId,
  })
  return { reviews: data.user_books }
})

const getEntry = Effect.fn(function* getLibraryEntry(params: typeof GetEntry.parametersSchema.Type) {
  const entry = yield* findEntry(params.bookId)
  return { entry: writes.named(Option.getOrNull(entry)) }
})

const setStatus = Effect.fn(function* setReadingStatus(params: typeof SetStatus.parametersSchema.Type) {
  return yield* upsertEntry({
    bookId: params.bookId,
    object: {
      edition_id: params.editionId,
      privacy_setting_id: privacySetting(params.privacy),
      status_id: STATUS_IDS[params.status],
    },
    onInsert: {},
  })
})

const rateBook = Effect.fn(function* rateLibraryBook(params: typeof RateBook.parametersSchema.Type) {
  return yield* upsertEntry({
    bookId: params.bookId,
    object: { rating: params.rating },
    onInsert: { status_id: STATUS_IDS.read },
  })
})

const writeReview = Effect.fn(function* writeBookReview(params: typeof WriteReview.parametersSchema.Type) {
  const reviewedAt = params.reviewedAt ?? (yield* writes.today())
  return yield* upsertEntry({
    bookId: params.bookId,
    object: {
      rating: params.rating,
      review_has_spoilers: params.hasSpoilers ?? false,
      review_markdown: params.review,
      reviewed_at: reviewedAt,
    },
    onInsert: { status_id: STATUS_IDS.read },
  })
})

const clearedReview = (entry: unknown): Effect.Effect<unknown, HardcoverError> => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ has_review: Schema.optionalKey(Schema.Boolean) }))(entry)
  const kept = Option.exists(decoded, (row) => row.has_review === true)
  if (kept) {
    return HardcoverError.make({ kind: "unavailable", message: "Hardcover kept the review; it could not be cleared through the API." })
  }
  return Effect.succeed(writes.named(entry))
}

const deleteReview = Effect.fn(function* clearBookReview(params: typeof DeleteReview.parametersSchema.Type) {
  const entry = yield* requireEntry(params.bookId)
  // Hardcover ignores nulls here and derives the review from review_slate, so send an empty document.
  const result = yield* writes.updateEntry(entry.id, {
    review_has_spoilers: false,
    review_markdown: EMPTY_REVIEW,
    review_slate: EMPTY_REVIEW_SLATE,
  })
  return { entry: yield* clearedReview(result.user_book) }
})

const entryChanges = (params: typeof UpdateEntry.parametersSchema.Type): EntryEdit => ({
  date_added: params.dateAdded,
  edition_id: params.editionId,
  first_started_reading_date: params.firstStartedReadingDate,
  last_read_date: params.lastReadDate,
  privacy_setting_id: privacySetting(params.privacy),
  private_notes: params.privateNotes,
  read_count: params.readCount,
  recommended_by: params.recommendedBy,
  recommended_for: params.recommendedFor,
})

const updateLibraryEntry = Effect.fn(function* editLibraryEntry(params: typeof UpdateEntry.parametersSchema.Type) {
  const entry = yield* requireEntry(params.bookId)
  const object = entryChanges(params)
  if (Arr.every(Rec.values<string, unknown>(object), Predicate.isUndefined)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
  }
  const updated = yield* writes.updateEntry(entry.id, object)
  return { entry: writes.named(updated.user_book) }
})

const removeFromLibrary = Effect.fn(function* deleteLibraryEntry(params: typeof RemoveFromLibrary.parametersSchema.Type) {
  const entry = yield* requireEntry(params.bookId)
  const data = yield* deleteUserBook({ id: entry.id })
  const deleted = data.delete_user_book
  if (Predicate.isNull(deleted) || Predicate.isNull(deleted.id)) {
    return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover did not confirm the removal." })
  }
  return { removed: true, userBookId: entry.id }
})

const updateProgress = Effect.fn(function* updateReadingProgress(params: typeof UpdateProgress.parametersSchema.Type) {
  return yield* recordProgress({
    bookId: params.bookId,
    editionId: params.editionId,
    page: params.page,
    percent: params.percent,
    seconds: params.seconds,
    startedAt: params.startedAt,
  })
})

const markBookFinished = Effect.fn(function* finishReading(params: typeof MarkFinished.parametersSchema.Type) {
  return yield* markFinished({ bookId: params.bookId, finishedAt: params.finishedAt, rating: params.rating })
})

const editionForNewRead = (params: typeof AddRead.parametersSchema.Type, entry: Entry): number | undefined => {
  if (Predicate.isNotUndefined(params.editionId)) {
    return params.editionId
  }
  return Option.getOrUndefined(Option.fromNullishOr(entry.edition_id))
}

const addRead = Effect.fn(function* addReadingSession(params: typeof AddRead.parametersSchema.Type) {
  if (Predicate.isUndefined(params.startedAt) && Predicate.isUndefined(params.finishedAt)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Pass startedAt and/or finishedAt." })
  }
  const entry = yield* requireEntry(params.bookId)
  const result = yield* writes.insertRead(entry.id, {
    edition_id: editionForNewRead(params, entry),
    finished_at: params.finishedAt,
    started_at: params.startedAt,
  })
  return { read: result.user_book_read }
})

const readChanges = (params: typeof UpdateRead.parametersSchema.Type): ReadChanges => ({
  edition_id: params.editionId,
  finished_at: params.finishedAt,
  progress_pages: params.page,
  progress_seconds: params.seconds,
  started_at: params.startedAt,
})

const updateReading = Effect.fn(function* editReadingSession(params: typeof UpdateRead.parametersSchema.Type) {
  const read = yield* readById(params.readId)
  const changes = readChanges(params)
  if (Arr.every(Rec.values<string, unknown>(changes), Predicate.isUndefined)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
  }
  const updated = yield* writes.updateRead(read, changes)
  return { read: updated.user_book_read }
})

const deleteRead = Effect.fn(function* deleteReadingSession(params: typeof DeleteRead.parametersSchema.Type) {
  yield* readById(params.readId)
  const data = yield* deleteUserBookRead({ id: params.readId })
  yield* payload({ field: "delete_user_book_read", value: data.delete_user_book_read })
  return { deleted: params.readId }
})

const setOwned = Effect.fn(function* setEditionOwnership(params: typeof SetOwned.parametersSchema.Type) {
  return yield* setEditionOwned({ editionId: params.editionId, owned: params.owned })
})

const libraryHandlers = {
  hardcover_add_read: addRead,
  hardcover_currently_reading: currentlyReading,
  hardcover_delete_read: deleteRead,
  hardcover_delete_review: deleteReview,
  hardcover_get_library_entry: getEntry,
  hardcover_list_library: listLibrary,
  hardcover_list_reviews: listReviews,
  hardcover_mark_finished: markBookFinished,
  hardcover_rate_book: rateBook,
  hardcover_remove_from_library: removeFromLibrary,
  hardcover_set_owned: setOwned,
  hardcover_set_status: setStatus,
  hardcover_update_library_entry: updateLibraryEntry,
  hardcover_update_progress: updateProgress,
  hardcover_update_read: updateReading,
  hardcover_write_review: writeReview,
}

const LibraryToolkitLive = LibraryToolkit.toLayer(libraryHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { LibraryToolkitLive }
