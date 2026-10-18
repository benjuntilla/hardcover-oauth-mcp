/** Handlers for the list tools. */
import { AddToList, CreateList, DeleteList, GetList, ListLists, RemoveFromList, ReorderList, UpdateList } from "./list-tools.ts"
import { Array as Arr, Effect, Option, Order, Predicate, Result, Struct, pipe } from "effect"
import type { EditedList, ListRowType, NewList, OrderedListBookType } from "./list-operations.ts"
import {
  insertList,
  insertListBook,
  listBookEntries,
  listOrder,
  listWithBooks,
  listsOf,
  removeList,
  removeListBook,
  reorderListBooks,
  saveList,
} from "./list-operations.ts"
import { payload, privacyId } from "./common.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { ownList } from "./list-rows.ts"

const DEFAULT_LIST_PAGE = 50
const EMPTY_COUNT = 0
const FIRST_POSITION = 1
const UNRANKED = false

const kept = (value: string | null | undefined): Option.Option<string> => Option.fromNullishOr(value)

const listObject = (list: ListRowType, params: typeof UpdateList.parametersSchema.Type): EditedList => ({
  default_view: Option.getOrUndefined(kept(list.default_view)),
  description: params.description ?? Option.getOrUndefined(kept(list.description)),
  featured_profile: list.featured_profile ?? false,
  name: params.name ?? list.name,
  privacy_setting_id: Option.match(Option.fromNullishOr(params.privacy), {
    onNone: () => list.privacy_setting_id,
    onSome: privacyId,
  }),
  ranked: params.ranked ?? list.ranked ?? false,
  url: Option.getOrUndefined(kept(list.url)),
})

/**
 * The new list, with privacy left out unless the caller gave one, so Hardcover applies its default.
 * @param {typeof CreateList.parametersSchema.Type} params The list the caller asked for.
 * @returns {NewList} The `ListInput` to insert.
 */
const createdList = (params: typeof CreateList.parametersSchema.Type): NewList => {
  const list = { description: params.description, name: params.name, ranked: params.ranked ?? UNRANKED }
  return Option.match(Option.fromNullishOr(params.privacy), {
    onNone: () => list,
    onSome: (privacy) => Struct.assign(list, { privacy_setting_id: privacyId(privacy) }),
  })
}

const missingBooks = (bookIds: ReadonlyArray<number>, rows: ReadonlyArray<OrderedListBookType>): ReadonlyArray<number> =>
  pipe(
    bookIds,
    Arr.filter((bookId) =>
      pipe(
        rows,
        Arr.every((row) => row.book_id !== bookId),
      ),
    ),
  )

const rankOf = (ranks: ReadonlyMap<number, number>, bookIds: ReadonlyArray<number>, bookId: number): number =>
  ranks.get(bookId) ?? Arr.length(bookIds)

const byRequestedOrder = (bookIds: ReadonlyArray<number>): Order.Order<OrderedListBookType> => {
  const ranks = new Map(
    pipe(
      bookIds,
      Arr.map((bookId, index) => [bookId, index] as const),
    ),
  )
  return Order.mapInput(Order.Number, (row: OrderedListBookType) => rankOf(ranks, bookIds, row.book_id))
}

const positionUpdates = (
  ordered: ReadonlyArray<OrderedListBookType>,
): ReadonlyArray<Readonly<{ _set: Readonly<{ position: number }>; where: Readonly<{ id: Readonly<{ _eq: number }> }> }>> =>
  pipe(
    ordered,
    Arr.filterMap((row, index) => {
      const position = index + FIRST_POSITION
      return row.position === position ? Result.failVoid : Result.succeed({ _set: { position }, where: { id: { _eq: row.id } } })
    }),
  )

const orderResult = (ordered: ReadonlyArray<OrderedListBookType>): ReadonlyArray<Readonly<{ bookId: number; position: number }>> =>
  pipe(
    ordered,
    Arr.map((row, index) => ({ bookId: row.book_id, position: index + FIRST_POSITION })),
  )

const reordered = (
  rows: ReadonlyArray<OrderedListBookType>,
  bookIds: ReadonlyArray<number>,
): Effect.Effect<ReadonlyArray<OrderedListBookType>, HardcoverError, Session> =>
  Effect.gen(function* reorderRows() {
    const missing = missingBooks(bookIds, rows)
    if (Arr.isReadonlyArrayNonEmpty(missing)) {
      const listed = pipe(missing, Arr.map(String), Arr.join(", "))
      return yield* HardcoverError.make({ kind: "invalid", message: `Not on the list: ${listed}.` })
    }
    const ordered = pipe(rows, Arr.sortBy(byRequestedOrder(bookIds)))
    const updates = positionUpdates(ordered)
    if (Arr.isReadonlyArrayNonEmpty(updates)) {
      yield* reorderListBooks({ updates })
    }
    return ordered
  })

const listHandlers = {
  hardcover_add_to_list: Effect.fn(function* addToList(params: typeof AddToList.parametersSchema.Type) {
    const data = yield* insertListBook({
      object: { book_id: params.bookId, edition_id: params.editionId, list_id: params.listId, position: params.position },
    })
    const inserted = Option.fromNullishOr(data.insert_list_book)
    if (Option.isNone(inserted) || Predicate.isNull(inserted.value.id)) {
      return yield* HardcoverError.make({
        kind: "invalid",
        message: "Hardcover did not add the book; check the list is yours and the ids are right.",
      })
    }
    return { listBook: inserted.value.list_book }
  }),

  hardcover_create_list: Effect.fn(function* createList(params: typeof CreateList.parametersSchema.Type) {
    const data = yield* insertList({ object: createdList(params) })
    const inserted = yield* payload({ field: "insert_list", value: data.insert_list })
    return { list: inserted.list }
  }),

  hardcover_delete_list: Effect.fn(function* deleteList(params: typeof DeleteList.parametersSchema.Type) {
    yield* ownList(params.listId)
    const data = yield* removeList({ id: params.listId })
    if (Option.match(Option.fromNullishOr(data.delete_list), { onNone: () => false, onSome: (row) => row.success }) !== true) {
      return yield* HardcoverError.make({ kind: "unavailable", message: "Hardcover did not delete the list." })
    }
    return { deleted: params.listId }
  }),

  hardcover_get_list: Effect.fn(function* getList(params: typeof GetList.parametersSchema.Type) {
    const { limit = DEFAULT_LIST_PAGE, listId, offset = EMPTY_COUNT } = params
    const data = yield* listWithBooks({ id: listId, limit, offset })
    if (Predicate.isNull(data.lists_by_pk)) {
      return yield* HardcoverError.make({ kind: "not_found", message: `No list ${listId} you can see.` })
    }
    return { list: data.lists_by_pk }
  }),

  hardcover_list_lists: Effect.fn(function* listLists() {
    const { hcUserId } = yield* Session
    const data = yield* listsOf({ userId: hcUserId })
    return { followed: data.followed_lists, lists: data.lists }
  }),

  hardcover_remove_from_list: Effect.fn(function* removeFromList(params: typeof RemoveFromList.parametersSchema.Type) {
    yield* ownList(params.listId)
    const data = yield* listBookEntries({ bookId: params.bookId, listId: params.listId })
    if (Arr.isReadonlyArrayEmpty(data.list_books)) {
      return yield* HardcoverError.make({ kind: "not_found", message: `Book ${params.bookId} is not on list ${params.listId}.` })
    }
    const remove = (row: (typeof data.list_books)[number]): Effect.Effect<unknown, HardcoverError, Session> =>
      removeListBook({ id: row.id })
    yield* pipe(data.list_books, Effect.forEach(remove))
    return { removed: Arr.length(data.list_books) }
  }),

  hardcover_reorder_list: Effect.fn(function* reorderList(params: typeof ReorderList.parametersSchema.Type) {
    yield* ownList(params.listId)
    const data = yield* listOrder({ listId: params.listId })
    const ordered = yield* reordered(data.list_books, params.bookIds)
    return { order: orderResult(ordered) }
  }),

  hardcover_update_list: Effect.fn(function* updateList(params: typeof UpdateList.parametersSchema.Type) {
    const list = yield* ownList(params.listId)
    const data = yield* saveList({ id: list.id, object: listObject(list, params) })
    const updated = yield* payload({ field: "update_list", value: data.update_list })
    return { list: updated.list }
  }),
}

const ListsToolkit = Toolkit.make(ListLists, GetList, CreateList, UpdateList, DeleteList, AddToList, RemoveFromList, ReorderList)
const ListsToolkitLive = ListsToolkit.toLayer(listHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { ListsToolkit, ListsToolkitLive }
