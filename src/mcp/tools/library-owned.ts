/** Ownership follows Hardcover's Owned list, not the library entry. */
import { Array as Arr, Effect, Predicate, pipe } from "effect"
import { deleteListBook, markOwned, ownedRowsOf } from "./library-operations.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"

/**
 * The edition's rows in the user's Owned list.
 * @param {number} editionId The edition id.
 * @returns {Effect.Effect<ReadonlyArray<number>>} The list_book ids.
 */
const ownedRows = (editionId: number): Effect.Effect<ReadonlyArray<number>, HardcoverError, Session> =>
  Effect.gen(function* lookupOwned() {
    const session = yield* Session
    const data = yield* ownedRowsOf({ editionId, userId: session.hcUserId })
    return pipe(
      data.lists,
      Arr.flatMap((list) =>
        pipe(
          list.list_books,
          Arr.map((row) => row.id),
        ),
      ),
    )
  })

const unownEdition = (ids: ReadonlyArray<number>): Effect.Effect<void, HardcoverError, Session> =>
  Effect.forEach(ids, (id) => deleteListBook({ id }), { discard: true })

const ownEdition = (editionId: number): Effect.Effect<{ readonly changed: true; readonly owned: true }, HardcoverError, Session> =>
  Effect.gen(function* markEditionOwned() {
    const data = yield* markOwned({ id: editionId })
    const owned = data.edition_owned
    if (Predicate.isNull(owned) || Predicate.isNullish(owned.id)) {
      return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover did not accept the change." })
    }
    return { changed: true, owned: true }
  })

/**
 * Adds or removes an edition from the Owned list, skipping a no-op.
 * @param {object} options The edition and whether it should be owned.
 * @param {number} options.editionId The edition id.
 * @param {boolean} options.owned Whether the edition should be owned.
 * @returns {Effect.Effect} Whether the list changed.
 */
const setEditionOwned = (
  options: Readonly<{
    editionId: number
    owned: boolean
  }>,
): Effect.Effect<{ readonly changed: boolean; readonly owned: boolean }, HardcoverError, Session> =>
  Effect.gen(function* writeOwned() {
    const rows = yield* ownedRows(options.editionId)
    const alreadyOwned = Arr.isReadonlyArrayNonEmpty(rows)
    if (alreadyOwned === options.owned) {
      return { changed: false, owned: options.owned }
    }
    if (options.owned) {
      return yield* ownEdition(options.editionId)
    }
    yield* unownEdition(rows)
    return { changed: true, owned: false }
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { setEditionOwned }
