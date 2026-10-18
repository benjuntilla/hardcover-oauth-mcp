/** The check that a list belongs to the caller. */
import { Effect, Option } from "effect"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { ListRowType } from "#src/mcp/tools/list-operations.ts"
import { Session } from "#src/mcp/session.ts"
import { ownListRow } from "#src/mcp/tools/list-operations.ts"

/**
 * The caller's own list, or not_found when the id belongs to someone else.
 * @param {number} listId The list id.
 * @returns {Effect.Effect<ListRowType, HardcoverError, Session>} The list row.
 */
const ownList = (listId: number): Effect.Effect<ListRowType, HardcoverError, Session> =>
  Effect.gen(function* loadOwnList() {
    const { hcUserId } = yield* Session
    const data = yield* ownListRow({ id: listId })
    const list = Option.fromNullishOr(data.lists_by_pk)
    if (Option.isNone(list) || list.value.user_id !== hcUserId) {
      return yield* HardcoverError.make({ kind: "not_found", message: `List ${listId} is not one of your lists.` })
    }
    return list.value
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { ownList }
