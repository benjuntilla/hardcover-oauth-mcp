/** Handlers for the library tools, through the SDK's library and reads resources. */
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
import { Array as Arr, DateTime, Effect, Option, Predicate, Struct, pipe } from "effect"
import { call, privacySetting, readingStatus } from "./common.ts"
import type { OwnedBook } from "@hardcover/sdk"
import { UserBookStatus } from "@hardcover/sdk"
import type { Session } from "#src/mcp/session.ts"
import { defined, isBlank } from "./sdk-fields.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { LibraryToolkit } from "./library-tools.ts"

const DEFAULT_LIBRARY_LIMIT = 25
const DEFAULT_OFFSET = 0
const DEFAULT_REVIEW_LIMIT = 10
const EMPTY_REVIEW = ""
const EMPTY_REVIEW_SLATE = { document: { children: [], object: "document" } }
const CURRENTLY_READING_LIMIT = 100
const ONE_UNIT = 1
const OWNED_PAGE = 100
const OWNED_SEARCH_LIMIT = 1000
const START = 0

const listLibrary = Effect.fn(function* listLibraryBooks(params: typeof ListLibrary.parametersSchema.Type) {
  const listed = { limit: params.limit ?? DEFAULT_LIBRARY_LIMIT, offset: params.offset ?? DEFAULT_OFFSET }
  const page = yield* call((hardcover) =>
    hardcover.client.library.list(
      Predicate.isUndefined(params.status) ? listed : Struct.assign(listed, { status: readingStatus(params.status) }),
    ),
  )
  const total = yield* call((hardcover) =>
    hardcover.client.library.count(Predicate.isUndefined(params.status) ? {} : { status: readingStatus(params.status) }),
  )
  return { books: page.items, total }
})

const currentlyReading = Effect.fn(function* listCurrentlyReading() {
  const page = yield* call((hardcover) =>
    hardcover.client.library.list({ limit: CURRENTLY_READING_LIMIT, status: UserBookStatus.CurrentlyReading }),
  )
  return { books: page.items }
})

const REVIEWS_QUERY = `query Reviews($userId: Int!, $limit: Int!, $offset: Int!) {
  user_books(where: {user_id: {_eq: $userId}, has_review: {_eq: true}}, order_by: {updated_at: desc}, limit: $limit, offset: $offset) {
    id book_id rating review review_has_spoilers reviewed_at status_id
  }
}`

const listReviews = Effect.fn(function* listReviewedBooks(params: typeof ListReviews.parametersSchema.Type) {
  const page = yield* call((hardcover) =>
    hardcover.client.graphql<{ user_books: ReadonlyArray<unknown> }>(REVIEWS_QUERY, {
      limit: params.limit ?? DEFAULT_REVIEW_LIMIT,
      offset: params.offset ?? DEFAULT_OFFSET,
      userId: hardcover.userId,
    }),
  )
  return { reviews: page.user_books }
})

const entryFor = (bookId: number) => call((hardcover) => hardcover.client.library.forBook(bookId))

const requireEntry = (bookId: number) =>
  Effect.map(
    Effect.filterOrElse(entryFor(bookId), Predicate.isNotNull, () =>
      HardcoverError.make({ kind: "not_found", message: `Book ${bookId} is not in your library.` }),
    ),
    (entry) => entry,
  )

const getEntry = Effect.fn(function* getLibraryEntry(params: typeof GetEntry.parametersSchema.Type) {
  return { entry: yield* entryFor(params.bookId) }
})

const setStatus = Effect.fn(function* setReadingStatus(params: typeof SetStatus.parametersSchema.Type) {
  const existing = yield* entryFor(params.bookId)
  const patch = defined({ editionId: params.editionId, privacy: privacySetting(params.privacy), status: readingStatus(params.status) })
  const entry = Predicate.isNull(existing)
    ? yield* call((hardcover) => hardcover.client.library.add(params.bookId, patch))
    : yield* call((hardcover) => hardcover.client.library.update(existing.id, patch))
  return { added: Predicate.isNull(existing), entry }
})

const rateBook = Effect.fn(function* rateLibraryBook(params: typeof RateBook.parametersSchema.Type) {
  const existing = yield* entryFor(params.bookId)
  const entry = Predicate.isNull(existing)
    ? yield* call((hardcover) => hardcover.client.library.add(params.bookId, { rating: params.rating, status: UserBookStatus.Read }))
    : yield* call((hardcover) => hardcover.client.library.rate(existing.id, params.rating))
  return { added: Predicate.isNull(existing), entry }
})

const writeReview = Effect.fn(function* writeBookReview(params: typeof WriteReview.parametersSchema.Type) {
  const existing = yield* entryFor(params.bookId)
  const review = defined({ hasSpoilers: params.hasSpoilers, markdown: params.review, reviewedAt: params.reviewedAt })
  const patch = defined({ rating: params.rating, review, status: UserBookStatus.Read })
  const entry = Predicate.isNull(existing)
    ? yield* call((hardcover) => hardcover.client.library.add(params.bookId, patch))
    : yield* call((hardcover) => hardcover.client.library.update(existing.id, patch))
  return { added: Predicate.isNull(existing), entry }
})

const deleteReview = Effect.fn(function* clearBookReview(params: typeof DeleteReview.parametersSchema.Type) {
  const existing = yield* requireEntry(params.bookId)
  // Hardcover ignores nulls here and derives the review from review_slate, so send an empty document.
  const cleared = yield* call((hardcover) =>
    hardcover.client.graphql<{ update_user_book: { user_book: { has_review: boolean } | null } | null }>(
      "mutation ClearReview($id: Int!, $object: UserBookUpdateInput!) { update_user_book(id: $id, object: $object) { user_book { has_review } } }",
      { id: existing.id, object: { review_has_spoilers: false, review_markdown: EMPTY_REVIEW, review_slate: EMPTY_REVIEW_SLATE } },
    ),
  )
  if (cleared.update_user_book?.user_book?.has_review === true) {
    return yield* HardcoverError.make({
      kind: "unavailable",
      message: "Hardcover kept the review; it could not be cleared through the API.",
    })
  }
  return { entry: yield* entryFor(params.bookId) }
})

const updateLibraryEntry = Effect.fn(function* editLibraryEntry(params: typeof UpdateEntry.parametersSchema.Type) {
  const existing = yield* requireEntry(params.bookId)
  const patch = defined({
    editionId: params.editionId,
    notes: params.privateNotes,
    privacy: privacySetting(params.privacy),
    readCount: params.readCount,
    recommendedBy: params.recommendedBy,
    recommendedFor: params.recommendedFor,
    startDate: params.firstStartedReadingDate,
  })
  if (isBlank(patch)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
  }
  return { entry: yield* call((hardcover) => hardcover.client.library.update(existing.id, patch)) }
})

const removeFromLibrary = Effect.fn(function* deleteLibraryEntry(params: typeof RemoveFromLibrary.parametersSchema.Type) {
  const existing = yield* requireEntry(params.bookId)
  yield* call((hardcover) => hardcover.client.library.remove(existing.id))
  return { removed: true, userBookId: existing.id }
})

const readingEntry = (bookId: number, editionId: number | undefined) =>
  Effect.gen(function* ensureReading() {
    const existing = yield* entryFor(bookId)
    const created = Predicate.isNull(existing)
      ? yield* call((hardcover) => hardcover.client.library.add(bookId, defined({ editionId, status: UserBookStatus.CurrentlyReading })))
      : existing
    if (Predicate.isNotNull(existing) && existing.statusId !== UserBookStatus.CurrentlyReading) {
      yield* call((hardcover) => hardcover.client.library.setStatus(existing.id, UserBookStatus.CurrentlyReading))
    }
    const entry =
      Predicate.isNotNull(existing) && Predicate.isNotUndefined(editionId)
        ? yield* call((hardcover) => hardcover.client.library.update(existing.id, { editionId }))
        : created
    if (Predicate.isNull(entry)) {
      return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover did not return the library entry." })
    }
    return entry
  })

type Progress = { readonly pages: number } | { readonly seconds: number } | { readonly percent: number }

const progressOf = (params: typeof UpdateProgress.parametersSchema.Type): Progress => {
  const byPages = Option.fromNullishOr(params.page).pipe(Option.map((pages) => ({ pages })))
  const bySeconds = Option.fromNullishOr(params.seconds).pipe(Option.map((seconds) => ({ seconds })))
  return Option.getOrElse(
    Option.orElse(byPages, () => bySeconds),
    () => ({ percent: params.percent ?? START }),
  )
}

const updateProgress = Effect.fn(function* updateReadingProgress(params: typeof UpdateProgress.parametersSchema.Type) {
  const units = pipe([params.page, params.percent, params.seconds], Arr.filter(Predicate.isNotUndefined))
  if (units.length !== ONE_UNIT) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Pass exactly one of page, percent, or seconds." })
  }
  const entry = yield* readingEntry(params.bookId, params.editionId)
  const read = yield* call((hardcover) => hardcover.client.reads.setProgress(entry.id, progressOf(params)))
  return { read, status: "currently_reading" }
})

const markFinished = Effect.fn(function* finishBook(params: typeof MarkFinished.parametersSchema.Type) {
  const finishedAt = params.finishedAt ?? DateTime.formatIsoDateUtc(yield* DateTime.now)
  const existing = yield* entryFor(params.bookId)
  const entry = Predicate.isNull(existing)
    ? yield* call((hardcover) => hardcover.client.library.add(params.bookId, { status: UserBookStatus.Read }))
    : yield* call((hardcover) => hardcover.client.library.setStatus(existing.id, UserBookStatus.Read))
  const reads = yield* call((hardcover) => hardcover.client.reads.list(entry.id))
  const open = pipe(
    reads,
    Arr.findFirst((read) => Predicate.isNull(read.finishedAt)),
  )
  const read = Option.isSome(open)
    ? yield* call((hardcover) => hardcover.client.reads.update(open.value.id, { finishedAt }))
    : yield* call((hardcover) => hardcover.client.reads.add(entry.id, { finishedAt }))
  const rated = Predicate.isUndefined(params.rating)
    ? entry
    : yield* call((hardcover) => hardcover.client.library.rate(entry.id, params.rating ?? START))
  return { entry: rated, read }
})

const addRead = Effect.fn(function* addReadingSession(params: typeof AddRead.parametersSchema.Type) {
  if (Predicate.isUndefined(params.startedAt) && Predicate.isUndefined(params.finishedAt)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Pass startedAt and/or finishedAt." })
  }
  const existing = yield* requireEntry(params.bookId)
  const read = yield* call((hardcover) =>
    hardcover.client.reads.add(
      existing.id,
      defined({ editionId: params.editionId, finishedAt: params.finishedAt, startedAt: params.startedAt }),
    ),
  )
  return { read }
})

const updateRead = Effect.fn(function* editReadingSession(params: typeof UpdateRead.parametersSchema.Type) {
  const dates = defined({ editionId: params.editionId, finishedAt: params.finishedAt, startedAt: params.startedAt })
  const progress = defined({ progress_pages: params.page, progress_seconds: params.seconds })
  if (isBlank(dates) && isBlank(progress)) {
    return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
  }
  if (!isBlank(dates)) {
    yield* call((hardcover) => hardcover.client.reads.update(params.readId, dates))
  }
  if (!isBlank(progress)) {
    // Reads.update only sends dates. Progress is stored on the read row, so it goes through the mutation directly.
    yield* call((hardcover) =>
      hardcover.client.graphql(
        "mutation UpdateReadProgress($id: Int!, $read: DatesReadInput!) { update_user_book_read(id: $id, object: $read) { id } }",
        { id: params.readId, read: progress },
      ),
    )
  }
  return { read: Struct.assign(Struct.assign({ id: params.readId }, dates), progress) }
})

const deleteRead = Effect.fn(function* deleteReadingSession(params: typeof DeleteRead.parametersSchema.Type) {
  yield* call((hardcover) => hardcover.client.reads.delete(params.readId))
  return { deleted: params.readId }
})

const ownedPage = (editionId: number, offset: number): Effect.Effect<Option.Option<OwnedBook>, HardcoverError, Session> =>
  Effect.gen(function* searchOwned() {
    if (offset >= OWNED_SEARCH_LIMIT) {
      return Option.none()
    }
    const page = yield* call((hardcover) => hardcover.client.library.owned({ limit: OWNED_PAGE, offset }))
    const found = pipe(
      page.items,
      Arr.findFirst((item) => item.edition?.id === editionId),
    )
    if (Option.isSome(found) || !page.hasMore) {
      return found
    }
    return yield* ownedPage(editionId, offset + page.limit)
  })

const ownedEdition = (editionId: number): Effect.Effect<Option.Option<OwnedBook>, HardcoverError, Session> =>
  ownedPage(editionId, DEFAULT_OFFSET)

const setOwned = Effect.fn(function* setEditionOwned(params: typeof SetOwned.parametersSchema.Type) {
  if (params.owned) {
    const marked = yield* call((hardcover) => hardcover.client.library.markOwned(params.editionId))
    return { changed: true, listBook: marked, owned: true }
  }
  const row = yield* ownedEdition(params.editionId)
  if (Option.isNone(row) || Predicate.isNull(row.value.bookId)) {
    return { changed: false, owned: false }
  }
  const removed = yield* call((hardcover) => hardcover.client.library.unmarkOwned(row.value.bookId))
  return { changed: removed, owned: false }
})

const libraryHandlers = {
  hardcover_add_read: addRead,
  hardcover_currently_reading: currentlyReading,
  hardcover_delete_read: deleteRead,
  hardcover_delete_review: deleteReview,
  hardcover_get_library_entry: getEntry,
  hardcover_list_library: listLibrary,
  hardcover_list_reviews: listReviews,
  hardcover_mark_finished: markFinished,
  hardcover_rate_book: rateBook,
  hardcover_remove_from_library: removeFromLibrary,
  hardcover_set_owned: setOwned,
  hardcover_set_status: setStatus,
  hardcover_update_library_entry: updateLibraryEntry,
  hardcover_update_progress: updateProgress,
  hardcover_update_read: updateRead,
  hardcover_write_review: writeReview,
}

const LibraryToolkitLive = LibraryToolkit.toLayer(libraryHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { LibraryToolkitLive }
