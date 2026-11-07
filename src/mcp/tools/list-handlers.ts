/** Handlers for the list tools, through the SDK's lists resource. */
import { AddToList, CreateList, DeleteList, GetList, ListLists, RemoveFromList, ReorderList, UpdateList } from "./list-tools.ts"
import { Array as Arr, Effect, Predicate, Struct, pipe } from "effect"
import { call, privacySetting } from "./common.ts"
import { defined, isBlank } from "./sdk-fields.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { ListInput } from "@hardcover/sdk"
import { Toolkit } from "effect/ai"

const DEFAULT_LIST_PAGE = 50
const EMPTY_COUNT = 0
const FOLLOWED_LIMIT = 100
const REORDER_PAGE = 1000
const REMOVED_COUNT = 1
const POSITION_OFFSET = 1
const MISSING_SEPARATOR = ", "

const bookLabel = (bookId: number): string => `${bookId}`

interface ListBookRow {
  readonly bookId: number
  readonly id: number
}

const rowId =
  (byBook: ReadonlyMap<number, number>) =>
  (bookId: number): ReadonlyArray<number> => {
    const id = byBook.get(bookId)
    return Predicate.isUndefined(id) ? [] : [id]
  }

const placed = (bookId: number, index: number): { readonly bookId: number; readonly position: number } => ({
  bookId,
  position: index + POSITION_OFFSET,
})

const unnamedRows = (rows: ReadonlyArray<ListBookRow>, named: ReadonlySet<number>): ReadonlyArray<number> =>
  pipe(
    rows,
    Arr.map((row) => row.id),
    Arr.filter((id) => !named.has(id)),
  )

const orderedRows = (
  bookIds: ReadonlyArray<number>,
  listBooks: ReadonlyArray<ListBookRow>,
  byBook: ReadonlyMap<number, number>,
): { readonly ids: ReadonlyArray<number>; readonly order: ReadonlyArray<{ readonly bookId: number; readonly position: number }> } => {
  const unique = Arr.dedupe(bookIds)
  const rowIds = pipe(unique, Arr.flatMap(rowId(byBook)))
  // The SDK's reorder wants every row. Keep books the caller didn't name at the end.
  return { ids: Arr.appendAll(rowIds, unnamedRows(listBooks, new Set(rowIds))), order: pipe(unique, Arr.map(placed)) }
}

const listOrder = Effect.fn(function* listOrder(params: typeof ReorderList.parametersSchema.Type) {
  const list = yield* call((hardcover) => hardcover.client.lists.get(params.listId, { limit: REORDER_PAGE }))
  if (Predicate.isNull(list)) {
    return yield* HardcoverError.make({ kind: "not_found", message: `No list ${params.listId} you can see.` })
  }
  const byBook = new Map(
    pipe(
      list.listBooks,
      Arr.map((row: ListBookRow) => [row.bookId, row.id] as const),
    ),
  )
  const missing = pipe(
    params.bookIds,
    Arr.filter((bookId) => !byBook.has(bookId)),
  )
  if (Arr.isReadonlyArrayNonEmpty(missing)) {
    return yield* HardcoverError.make({
      kind: "invalid",
      message: `Not on the list: ${pipe(missing, Arr.map(bookLabel), Arr.join(MISSING_SEPARATOR))}.`,
    })
  }
  return orderedRows(params.bookIds, list.listBooks, byBook)
})

const listHandlers = {
  hardcover_add_to_list: Effect.fn(function* addToList(params: typeof AddToList.parametersSchema.Type) {
    const listBook = yield* call((hardcover) =>
      hardcover.client.lists.addBook(params.listId, params.bookId, defined({ editionId: params.editionId, position: params.position })),
    )
    return { listBook }
  }),

  hardcover_create_list: Effect.fn(function* createList(params: typeof CreateList.parametersSchema.Type) {
    const extras: ListInput = defined({
      description: params.description,
      privacy: privacySetting(params.privacy),
      ranked: params.ranked,
    })
    const list = yield* call((hardcover) => hardcover.client.lists.create(Struct.assign(extras, { name: params.name })))
    return { list }
  }),

  hardcover_delete_list: Effect.fn(function* deleteList(params: typeof DeleteList.parametersSchema.Type) {
    yield* call((hardcover) => hardcover.client.lists.delete(params.listId))
    return { deleted: params.listId }
  }),

  hardcover_get_list: Effect.fn(function* getList(params: typeof GetList.parametersSchema.Type) {
    const list = yield* call((hardcover) =>
      hardcover.client.lists.get(params.listId, { limit: params.limit ?? DEFAULT_LIST_PAGE, offset: params.offset ?? EMPTY_COUNT }),
    )
    if (Predicate.isNull(list)) {
      return yield* HardcoverError.make({ kind: "not_found", message: `No list ${params.listId} you can see.` })
    }
    return { list }
  }),

  hardcover_list_lists: Effect.fn(function* listLists() {
    const lists = yield* call((hardcover) => hardcover.client.lists.mine({ limit: FOLLOWED_LIMIT }))
    const followed = yield* call((hardcover) => hardcover.client.lists.followed({ limit: FOLLOWED_LIMIT }))
    return { followed: followed.items, lists: lists.items }
  }),

  hardcover_remove_from_list: Effect.fn(function* removeFromList(params: typeof RemoveFromList.parametersSchema.Type) {
    const removed = yield* call((hardcover) => hardcover.client.lists.removeBook(params.listId, params.bookId))
    if (!removed) {
      return yield* HardcoverError.make({ kind: "not_found", message: `Book ${params.bookId} is not on list ${params.listId}.` })
    }
    return { removed: REMOVED_COUNT }
  }),

  hardcover_reorder_list: Effect.fn(function* reorderList(params: typeof ReorderList.parametersSchema.Type) {
    const ordered = yield* listOrder(params)
    yield* call((hardcover) => hardcover.client.lists.reorder(params.listId, Arr.copy(ordered.ids)))
    return { order: ordered.order }
  }),

  hardcover_update_list: Effect.fn(function* updateList(params: typeof UpdateList.parametersSchema.Type) {
    const patch = defined({
      description: params.description,
      name: params.name,
      privacy: privacySetting(params.privacy),
      ranked: params.ranked,
    })
    if (isBlank(patch)) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
    }
    return { list: yield* call((hardcover) => hardcover.client.lists.update(params.listId, patch)) }
  }),
}

const ListsToolkit = Toolkit.make(ListLists, GetList, CreateList, UpdateList, DeleteList, AddToList, RemoveFromList, ReorderList)
const ListsToolkitLive = ListsToolkit.toLayer(listHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { ListsToolkit, ListsToolkitLive }
