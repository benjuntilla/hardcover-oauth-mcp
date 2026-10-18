/** Progress and finish dates for a book's open reading session. */
import { Array as Arr, Effect, Number as Num, Option, Predicate, Struct, pipe } from "effect"
import type { EditionLengths, Entry, Read } from "./library-fields.ts"
import type { ReadChanges, ReadProgress } from "./library-operations.ts"
import { findEntry, requireEntry, upsertEntry, writes } from "./library-store.ts"
import { named, today } from "./library-status.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { STATUS_IDS } from "./common.ts"
import type { Session } from "#src/mcp/session.ts"

const EXPECTED_PROGRESS_FIELDS = 1
const PERCENT_SCALE = 100
const WHOLE_NUMBER = 0

interface FinishInput {
  readonly bookId: number
  readonly finishedAt?: string | undefined
  readonly rating?: number | undefined
}

interface ProgressInput {
  readonly bookId: number
  readonly editionId?: number | undefined
  readonly page?: number | undefined
  readonly percent?: number | undefined
  readonly seconds?: number | undefined
  readonly startedAt?: string | undefined
}

interface FinishResult {
  readonly entry: unknown
  readonly read: unknown
}

interface ProgressResult {
  readonly read: unknown
  readonly status: string
}

interface SessionWrite {
  readonly editionId: number | undefined
  readonly entry: Entry
  readonly open: Option.Option<Read>
  readonly progress: ReadProgress
  readonly startedAt: string | undefined
}

/**
 * The open reading session, if the entry has one.
 * @param {Entry} entry The library row.
 * @returns {Option.Option<Read>} The newest unfinished session.
 */
const openRead = (entry: Entry): Option.Option<Read> =>
  pipe(
    entry.user_book_reads ?? [],
    Arr.findFirst((read) => Predicate.isNull(read.finished_at)),
  )

/**
 * Page and audio length for the edition being read, falling back to the entry's edition.
 * @param {Entry} entry The library row.
 * @param {Option.Option<Read>} open The open session.
 * @returns {Option.Option<EditionLengths>} The lengths.
 */
const readingEdition = (entry: Entry, open: Option.Option<Read>): Option.Option<typeof EditionLengths.Type> =>
  pipe(
    open,
    Option.flatMap((read) => Option.fromNullishOr(read.edition)),
    Option.orElse(() => Option.fromNullishOr(entry.edition)),
  )

/**
 * The first length that is present.
 * @param {Option.Option<number>} primary The preferred length.
 * @param {Option.Option<number>} fallback The length to use otherwise.
 * @returns {Option.Option<number>} The length.
 */
const lengthOr = (primary: Option.Option<number>, fallback: Option.Option<number>): Option.Option<number> =>
  Option.orElse(primary, () => fallback)

const present = (value: number | null | undefined): Option.Option<number> => Option.fromNullishOr(value)

const editionField = (
  edition: Option.Option<typeof EditionLengths.Type>,
  pick: (value: typeof EditionLengths.Type) => number | null,
): Option.Option<number> => pipe(edition, Option.map(pick), Option.flatMap(present))

const bookField = (entry: Entry, pick: (value: NonNullable<Entry["book"]>) => number | null): Option.Option<number> =>
  pipe(Option.fromNullishOr(entry.book), Option.map(pick), Option.flatMap(present))

/**
 * A percent as whole pages or seconds.
 * @param {number} percent Zero to 100.
 * @param {number} length The edition or book length.
 * @returns {number} The rounded position.
 */
const scaled = (percent: number, length: number): number => {
  const fraction = Num.divideUnsafe(percent, PERCENT_SCALE)
  return Num.round(Num.multiply(fraction, length), WHOLE_NUMBER)
}

const audioOnlySeconds = (editionSeconds: Option.Option<number>, editionPageCount: Option.Option<number>): Option.Option<number> =>
  Option.isSome(editionSeconds) && Option.isNone(editionPageCount) ? editionSeconds : Option.none()

const scaledPages = (percent: number, pages: Option.Option<number>): Option.Option<ReadProgress> => {
  if (Option.isNone(pages)) {
    return Option.none()
  }
  return Option.some({ progress_pages: scaled(percent, pages.value) })
}

const editionLengths = (
  options: Readonly<{ edition: Option.Option<typeof EditionLengths.Type>; entry: Entry }>,
): Readonly<{ pages: Option.Option<number>; seconds: Option.Option<number> }> => ({
  pages: editionField(options.edition, (edition) => edition.pages),
  seconds: editionField(options.edition, (edition) => edition.audio_seconds),
})

const pageProgress = (
  options: Readonly<{ entry: Entry; percent: number }>,
  editionPageCount: Option.Option<number>,
): Option.Option<ReadProgress> => {
  const bookPageCount = bookField(options.entry, (book) => book.pages)
  return scaledPages(options.percent, lengthOr(editionPageCount, bookPageCount))
}

const secondProgress = (
  options: Readonly<{ entry: Entry; percent: number }>,
  editionSeconds: Option.Option<number>,
): Option.Option<ReadProgress> => {
  const bookSeconds = bookField(options.entry, (book) => book.audio_seconds)
  const seconds = lengthOr(editionSeconds, bookSeconds)
  if (Option.isNone(seconds)) {
    return Option.none()
  }
  return Option.some({ progress_seconds: scaled(options.percent, seconds.value) })
}

const chosenLength = (
  options: Readonly<{ edition: Option.Option<typeof EditionLengths.Type>; entry: Entry; percent: number }>,
): Option.Option<ReadProgress> => {
  const lengths = editionLengths(options)
  const audioOnly = audioOnlySeconds(lengths.seconds, lengths.pages)
  if (Option.isSome(audioOnly)) {
    return Option.some({ progress_seconds: scaled(options.percent, audioOnly.value) })
  }
  const pages = pageProgress(options, lengths.pages)
  if (Option.isSome(pages)) {
    return pages
  }
  return secondProgress(options, lengths.seconds)
}

/**
 * Turns a percent into pages or seconds. An audio-only edition uses its length; otherwise pages win.
 * @param {object} options The percent and the lengths it applies to.
 * @param {Option.Option<EditionLengths>} options.edition The edition being read.
 * @param {Entry} options.entry The library row, used when the edition has no length.
 * @param {number} options.percent Zero to 100.
 * @returns {Effect.Effect<ReadProgress>} The progress fields.
 */
const percentProgress = (
  options: Readonly<{
    edition: Option.Option<typeof EditionLengths.Type>
    entry: Entry
    percent: number
  }>,
): Effect.Effect<ReadProgress, HardcoverError> =>
  Option.match(chosenLength(options), {
    onNone: () => HardcoverError.make({ kind: "invalid", message: "This edition has no page count or length; pass page or seconds." }),
    onSome: Effect.succeed,
  })

/**
 * The progress fields for exactly one of page, seconds, or percent.
 * @param {ProgressInput} input What the caller asked to record.
 * @param {Entry} entry The library row.
 * @param {Option.Option<Read>} open The open session.
 * @returns {Effect.Effect<ReadProgress>} The progress fields.
 */
const progressFields = (input: ProgressInput, entry: Entry, open: Option.Option<Read>): Effect.Effect<ReadProgress, HardcoverError> => {
  if (Predicate.isNotUndefined(input.page)) {
    return Effect.succeed({ progress_pages: input.page })
  }
  if (Predicate.isNotUndefined(input.seconds)) {
    return Effect.succeed({ progress_seconds: input.seconds })
  }
  if (Predicate.isNotUndefined(input.percent)) {
    return percentProgress({ edition: readingEdition(entry, open), entry, percent: input.percent })
  }
  return HardcoverError.make({ kind: "invalid", message: "Pass exactly one of page, seconds, or percent." })
}

const givenCount = (input: ProgressInput): number =>
  pipe([input.page, input.seconds, input.percent], Arr.filter(Predicate.isNotUndefined), Arr.length)

/**
 * Makes sure the book is currently reading, adding it when it is not.
 * @param {ProgressInput} input The progress request.
 * @returns {Effect.Effect<Entry>} The library row after the status write.
 */
const readingEntry = (input: ProgressInput): Effect.Effect<Entry, HardcoverError, Session> =>
  Effect.gen(function* ensureReading() {
    const current = yield* findEntry(input.bookId)
    const alreadyReading = Option.exists(current, (entry) => entry.status_id === STATUS_IDS.currently_reading)
    if (!alreadyReading) {
      yield* upsertEntry({
        bookId: input.bookId,
        object: { edition_id: input.editionId, status_id: STATUS_IDS.currently_reading },
        onInsert: {},
      })
    }
    return yield* requireEntry(input.bookId)
  })

const withEdition = (progress: ReadProgress, editionId: number | undefined): ReadChanges =>
  Struct.assign({ edition_id: editionId })(progress)

const newSessionFields = (write: SessionWrite, date: string): ReadChanges =>
  Struct.assign({ started_at: date })(withEdition(write.progress, write.editionId))

const writeSession = (write: SessionWrite): Effect.Effect<{ readonly user_book_read: unknown }, HardcoverError, Session> =>
  Effect.gen(function* writeOpenOrNew() {
    if (Option.isSome(write.open)) {
      return yield* writes.updateRead(write.open.value, withEdition(write.progress, write.editionId))
    }
    const date = write.startedAt ?? (yield* today())
    return yield* writes.insertRead(write.entry.id, newSessionFields(write, date))
  })

/**
 * Records progress and returns the session that was written.
 * @param {ProgressInput} input The progress request.
 * @returns {Effect.Effect<ProgressResult>} The status and the session.
 */
const recordProgress = (input: ProgressInput): Effect.Effect<ProgressResult, HardcoverError, Session> =>
  Effect.gen(function* writeProgress() {
    if (givenCount(input) !== EXPECTED_PROGRESS_FIELDS) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Pass exactly one of page, seconds, or percent." })
    }
    const entry = yield* readingEntry(input)
    const open = openRead(entry)
    const fromOpen = pipe(
      open,
      Option.flatMap((read) => Option.fromNullishOr(read.edition_id)),
      Option.getOrUndefined,
    )
    const editionId = input.editionId ?? fromOpen ?? Option.getOrUndefined(Option.fromNullishOr(entry.edition_id))
    const progress = yield* progressFields(input, entry, open)
    const written = yield* writeSession({ editionId, entry, open, progress, startedAt: input.startedAt })
    return { read: written.user_book_read, status: "currently_reading" }
  })

const editionPages = (entry: Entry): Option.Option<number> =>
  pipe(
    Option.fromNullishOr(entry.edition),
    Option.flatMap((edition) => present(edition.pages)),
  )

const bookPages = (entry: Entry): Option.Option<number> => bookField(entry, (book) => book.pages)

const finishPages = (entry: Entry, open: Read): Option.Option<number> =>
  Predicate.isNotNullish(open.progress_seconds) ? Option.none() : lengthOr(editionPages(entry), bookPages(entry))

const finishSession = (
  entry: Entry,
  open: Option.Option<Read>,
  date: string,
): Effect.Effect<{ readonly user_book_read: unknown }, HardcoverError, Session> => {
  if (Option.isSome(open)) {
    const progressPages = Option.getOrUndefined(finishPages(entry, open.value))
    return writes.updateRead(open.value, { finished_at: date, progress_pages: progressPages })
  }
  const editionId = Option.getOrUndefined(Option.fromNullishOr(entry.edition_id))
  return writes.insertRead(entry.id, { edition_id: editionId, finished_at: date })
}

/**
 * Finishes the open session, or records a finished one, and sets the status to read.
 * @param {FinishInput} input The book, the finish date, and an optional rating.
 * @returns {Effect.Effect<FinishResult>} The session and the library row.
 */
const markFinished = (input: FinishInput): Effect.Effect<FinishResult, HardcoverError, Session> =>
  Effect.gen(function* finishBook() {
    const date = input.finishedAt ?? (yield* today())
    const existing = yield* findEntry(input.bookId)
    if (Option.isNone(existing)) {
      yield* upsertEntry({ bookId: input.bookId, object: { status_id: STATUS_IDS.read }, onInsert: {} })
    }
    const entry = yield* requireEntry(input.bookId)
    const read = yield* finishSession(entry, openRead(entry), date)
    const updated = yield* writes.updateEntry(entry.id, { last_read_date: date, rating: input.rating, status_id: STATUS_IDS.read })
    return { entry: named(updated.user_book), read: read.user_book_read }
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { markFinished, recordProgress }
