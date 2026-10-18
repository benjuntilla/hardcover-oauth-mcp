/** The GraphQL operations behind the list tools. */
import { Json, JsonList, Payload, run } from "#src/mcp/tools/common.ts"
import { GraphQL } from "effect/graphql"
import { Schema } from "effect"

const LIST_FIELDS = "id name slug description books_count privacy_setting_id ranked default_view featured_profile url updated_at"

const NullableString = Schema.NullOr(Schema.String)
const ListRow = Schema.Struct({
  default_view: Schema.optionalKey(NullableString),
  description: Schema.optionalKey(NullableString),
  featured_profile: Schema.optionalKey(Schema.Boolean),
  id: Schema.Int,
  name: Schema.String,
  privacy_setting_id: Schema.Int,
  ranked: Schema.optionalKey(Schema.Boolean),
  url: Schema.optionalKey(NullableString),
  user_id: Schema.Int,
})

const OwnListData = Schema.Struct({ lists_by_pk: Schema.NullOr(ListRow) })
const InsertedListBook = Schema.Struct({
  id: Schema.NullOr(Schema.Int),
  list_book: Json,
})
const InsertListBookData = Schema.Struct({ insert_list_book: Schema.NullOr(InsertedListBook) })
const DeletedList = Schema.Struct({ success: Schema.optionalKey(Schema.Boolean) })
const DeleteListData = Schema.Struct({ delete_list: Schema.NullOr(DeletedList) })
const ListBookId = Schema.Struct({ id: Schema.Int })
const ListBookIds = Schema.Struct({ list_books: Schema.Array(ListBookId) })
const OrderedListBook = Schema.Struct({
  book_id: Schema.Int,
  id: Schema.Int,
  position: Schema.optionalKey(Schema.NullOr(Schema.Int)),
})
const ListOrderData = Schema.Struct({ list_books: Schema.Array(OrderedListBook) })
const MyListsData = Schema.Struct({ followed_lists: JsonList, lists: JsonList })
const GetListData = Schema.Struct({ lists_by_pk: Schema.NullOr(Json) })
const ListBody = Payload({ list: Json })
const InsertListData = Schema.Struct({ insert_list: ListBody })
const UpdateListData = Schema.Struct({ update_list: ListBody })
const RemovedListBook = Schema.Struct({ delete_list_book: Schema.Unknown })
const ReorderData = Schema.Struct({ update_list_books_many: Schema.Unknown })

/** `ListBookInput`: the entry `insert_list_book` adds. */
const ListBookInput = Schema.Struct({
  book_id: Schema.Int,
  edition_id: Schema.optional(Schema.Int),
  list_id: Schema.Int,
  position: Schema.optional(Schema.Int),
})

/** `ListInput` for a new list. Privacy is left out, not sent, unless the caller gives one. */
const NewListInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  name: Schema.String,
  privacy_setting_id: Schema.optionalKey(Schema.Int),
  ranked: Schema.Boolean,
})

/** `ListInput` for an edit: `update_list` takes the whole list, so unchanged fields are sent back. */
const EditedListInput = Schema.Struct({
  default_view: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  featured_profile: Schema.Boolean,
  name: Schema.String,
  privacy_setting_id: Schema.Int,
  ranked: Schema.Boolean,
  url: Schema.optional(Schema.String),
})

/** `list_books_updates`: one entry's new position. */
const PositionUpdate = Schema.Struct({
  _set: Schema.Struct({ position: Schema.Int }),
  where: Schema.Struct({ id: Schema.Struct({ _eq: Schema.Int }) }),
})

const ownListRow = run(
  GraphQL.query("OwnList", {
    document: `query OwnList($id: Int!) { lists_by_pk(id: $id) { id user_id name description privacy_setting_id ranked default_view featured_profile url } }`,
    result: OwnListData,
    variables: { id: Schema.Int },
  }),
)

const listWithBooks = run(
  GraphQL.query("List", {
    document: `query List($id: Int!, $limit: Int!, $offset: Int!) {
        lists_by_pk(id: $id) {
          ${LIST_FIELDS} user_id user { username }
          list_books(order_by: [{position: asc_nulls_last}, {id: asc}], limit: $limit, offset: $offset) {
            id position date_added reason book_id edition_id
            book { id title slug release_year contributions(limit: 2) { author { name } } }
          }
        }
      }`,
    result: GetListData,
    variables: { id: Schema.Int, limit: Schema.Int, offset: Schema.Int },
  }),
)

const listsOf = run(
  GraphQL.query("MyLists", {
    document: `query MyLists($userId: Int!) {
        lists(where: {user_id: {_eq: $userId}}, order_by: {updated_at: desc_nulls_last}) { ${LIST_FIELDS} }
        followed_lists(where: {user_id: {_eq: $userId}}, order_by: {created_at: desc}) { id list { id name slug books_count user { username } } }
      }`,
    result: MyListsData,
    variables: { userId: Schema.Int },
  }),
)

const listBookEntries = run(
  GraphQL.query("FindListBook", {
    document: `query FindListBook($listId: Int!, $bookId: Int!) { list_books(where: {list_id: {_eq: $listId}, book_id: {_eq: $bookId}}) { id } }`,
    result: ListBookIds,
    variables: { bookId: Schema.Int, listId: Schema.Int },
  }),
)

const listOrder = run(
  GraphQL.query("ListOrder", {
    document: `query ListOrder($listId: Int!) { list_books(where: {list_id: {_eq: $listId}}, order_by: [{position: asc_nulls_last}, {id: asc}]) { id book_id position } }`,
    result: ListOrderData,
    variables: { listId: Schema.Int },
  }),
)

const insertListBook = run(
  GraphQL.mutation("AddToList", {
    document: `mutation AddToList($object: ListBookInput!) {
        insert_list_book(object: $object) { id list_book { id list_id book_id edition_id position date_added } }
      }`,
    result: InsertListBookData,
    variables: { object: ListBookInput },
  }),
)

const insertList = run(
  GraphQL.mutation("CreateList", {
    document: `mutation CreateList($object: ListInput!) { insert_list(object: $object) { id errors list { ${LIST_FIELDS} } } }`,
    result: InsertListData,
    variables: { object: NewListInput },
  }),
)

const saveList = run(
  GraphQL.mutation("UpdateList", {
    document: `mutation UpdateList($id: Int!, $object: ListInput!) { update_list(id: $id, object: $object) { id errors list { ${LIST_FIELDS} } } }`,
    result: UpdateListData,
    variables: { id: Schema.Int, object: EditedListInput },
  }),
)

const removeList = run(
  GraphQL.mutation("DeleteList", {
    document: `mutation DeleteList($id: Int!) { delete_list(id: $id) { success } }`,
    result: DeleteListData,
    variables: { id: Schema.Int },
  }),
)

const removeListBook = run(
  GraphQL.mutation("RemoveFromList", {
    document: `mutation RemoveFromList($id: Int!) { delete_list_book(id: $id) { id list_id } }`,
    result: RemovedListBook,
    variables: { id: Schema.Int },
  }),
)

const reorderListBooks = run(
  GraphQL.mutation("Reorder", {
    document: `mutation Reorder($updates: [list_books_updates!]!) { update_list_books_many(updates: $updates) { affected_rows } }`,
    result: ReorderData,
    variables: { updates: Schema.Array(PositionUpdate) },
  }),
)

type ListRowType = typeof ListRow.Type
type OrderedListBookType = typeof OrderedListBook.Type
type NewList = typeof NewListInput.Type
type EditedList = typeof EditedListInput.Type

/**
 * Application module, not a public API.
 * @internal
 */
export {
  insertList,
  insertListBook,
  listBookEntries,
  listOrder,
  listWithBooks,
  listsOf,
  ownListRow,
  removeList,
  removeListBook,
  reorderListBooks,
  saveList,
}
/**
 * Application module, not a public API.
 * @internal
 */
export type { EditedList, ListRowType, NewList, OrderedListBookType }
