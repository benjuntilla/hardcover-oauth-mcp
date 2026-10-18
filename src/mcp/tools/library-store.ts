/** Lookups and writes for the user's library row and reading sessions. */
import type { BookPayload, Entry, Read, ReadPayload } from "./library-fields.ts"
import { Effect, Option, Predicate, Struct } from "effect"
import type { EntryChanges, EntryEdit, NewEntryInput, ReadChanges } from "./library-operations.ts"
import { addUserBook, addUserBookRead, entryOf, readOf, updateUserBook, updateUserBookRead } from "./library-operations.ts"
import { named, today } from "./library-status.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { payload } from "./common.ts"

interface UpsertResult {
  readonly added: boolean
  readonly entry: unknown
}

/**
 * The user's library row for a book, with its reads (newest first), or none.
 * @param {number} bookId The book id.
 * @returns {Effect.Effect<Option.Option<Entry>>} The row.
 */
const findEntry = (bookId: number): Effect.Effect<Option.Option<Entry>, HardcoverError, Session> =>
  Effect.gen(function* lookupEntry() {
    const session = yield* Session
    const data = yield* entryOf({ bookId, userId: session.hcUserId })
    const [firstRow] = data.user_books
    return Option.fromNullishOr(firstRow)
  })

/**
 * The user's library row for a book, or `not_found`.
 * @param {number} bookId The book id.
 * @returns {Effect.Effect<Entry>} The row.
 */
const requireEntry = (bookId: number): Effect.Effect<Entry, HardcoverError, Session> =>
  Effect.flatMap(findEntry(bookId), (entry) =>
    Option.match(entry, {
      onNone: () =>
        HardcoverError.make({
          kind: "not_found",
          message: `Book ${bookId} is not in your library. Add it with hardcover_set_status first.`,
        }),
      onSome: Effect.succeed,
    }),
  )

/**
 * Adds a book to the library.
 * @param {NewEntryInput} object The create input.
 * @returns {Effect.Effect} The mutation payload.
 */
const insertEntry = (object: NewEntryInput): Effect.Effect<NonNullable<typeof BookPayload.Type>, HardcoverError, Session> =>
  Effect.flatMap(addUserBook({ object }), (data) => payload({ field: "insert_user_book", value: data.insert_user_book }))

/**
 * Updates one library row.
 * @param {number} id The user_book id.
 * @param {EntryEdit} object The update input.
 * @returns {Effect.Effect} The mutation payload.
 */
const updateEntry = (id: number, object: EntryEdit): Effect.Effect<NonNullable<typeof BookPayload.Type>, HardcoverError, Session> =>
  Effect.flatMap(updateUserBook({ id, object }), (data) => payload({ field: "update_user_book", value: data.update_user_book }))

/**
 * Updates the user's row for the book, or adds the book with `onInsert` merged in.
 * @param {object} options The book, the fields to write, and fields used only when inserting.
 * @param {number} options.bookId The book id.
 * @param {EntryChanges} options.object Fields written on update and insert.
 * @param {EntryChanges} options.onInsert Fields written only when the book is added.
 * @returns {Effect.Effect<UpsertResult>} Whether the book was added, and the resulting row.
 */
const upsertEntry = (
  options: Readonly<{
    bookId: number
    object: EntryChanges
    onInsert: EntryChanges
  }>,
): Effect.Effect<UpsertResult, HardcoverError, Session> =>
  Effect.gen(function* writeEntry() {
    const entry = yield* findEntry(options.bookId)
    if (Option.isSome(entry)) {
      const updated = yield* updateEntry(entry.value.id, options.object)
      return { added: false, entry: named(updated.user_book) }
    }
    const withBook = Struct.assign({ book_id: options.bookId })(options.onInsert)
    const inserted = yield* insertEntry(Struct.assign(options.object)(withBook))
    return { added: true, entry: named(inserted.user_book) }
  })

/**
 * Records a reading session on a library row.
 * @param {number} userBookId The user_book id.
 * @param {ReadChanges} read The session to record.
 * @returns {Effect.Effect} The mutation payload.
 */
const insertRead = (userBookId: number, read: ReadChanges): Effect.Effect<NonNullable<typeof ReadPayload.Type>, HardcoverError, Session> =>
  Effect.flatMap(addUserBookRead({ read, userBookId }), (data) =>
    payload({ field: "insert_user_book_read", value: data.insert_user_book_read }),
  )

const kept = <Value>(value: Value | null): Value | undefined => Option.getOrUndefined(Option.fromNullishOr(value))

const keptRead = (read: Read, changes: ReadChanges): ReadChanges => ({
  edition_id: changes.edition_id ?? kept(read.edition_id),
  finished_at: changes.finished_at ?? kept(read.finished_at),
  progress_pages: changes.progress_pages ?? kept(read.progress_pages),
  progress_seconds: changes.progress_seconds ?? kept(read.progress_seconds),
  started_at: changes.started_at ?? kept(read.started_at),
})

/**
 * `update_user_book_read` is a custom action; send the read's existing values back so nothing is cleared.
 * @param {Read} read The session as it is now.
 * @param {ReadChanges} changes The fields to change.
 * @returns {Effect.Effect} The mutation payload.
 */
const updateRead = (read: Read, changes: ReadChanges): Effect.Effect<NonNullable<typeof ReadPayload.Type>, HardcoverError, Session> =>
  Effect.flatMap(updateUserBookRead({ id: read.id, read: keptRead(read, changes) }), (data) =>
    payload({ field: "update_user_book_read", value: data.update_user_book_read }),
  )

/**
 * One of the user's reading sessions, or `not_found`.
 * @param {number} readId The reading session id.
 * @returns {Effect.Effect<Read>} The session.
 */
const readById = (readId: number): Effect.Effect<Read, HardcoverError, Session> =>
  Effect.gen(function* lookupRead() {
    const session = yield* Session
    const data = yield* readOf({ id: readId })
    const read = data.user_book_reads_by_pk
    if (Predicate.isNull(read) || read.user_book.user_id !== session.hcUserId) {
      return yield* HardcoverError.make({ kind: "not_found", message: `No reading session ${readId} in your library.` })
    }
    return read
  })

const writes = { insertRead, named, today, updateEntry, updateRead }

/**
 * Application module, not a public API.
 * @internal
 */
export { findEntry, readById, requireEntry, upsertEntry, writes }
