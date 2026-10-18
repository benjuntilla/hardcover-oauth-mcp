/** The GraphQL operations behind the library tools: entries (`user_books`), reading sessions (`user_book_reads`), and the Owned list. */
import {
  BookPayload,
  BookRows,
  DeletedBook,
  DeletedRead,
  ENTRY_FIELDS,
  EntryRows,
  LibraryPage,
  OwnedChange,
  OwnedLists,
  READ_FIELDS,
  ReadLookup,
  ReadPayload,
} from "./library-fields.ts"
import { Schema, Struct } from "effect"
import { GraphQL } from "effect/graphql"
import { run } from "./common.ts"

const OrderBy = Schema.Literals(["asc", "desc", "desc_nulls_last"])

/** `user_books_order_by`: the sort keys the library page uses. */
const EntryOrder = Schema.Struct({
  book: Schema.optional(Schema.Struct({ title: OrderBy })),
  date_added: Schema.optional(OrderBy),
  id: Schema.optional(OrderBy),
  last_read_date: Schema.optional(OrderBy),
  rating: Schema.optional(OrderBy),
  updated_at: Schema.optional(OrderBy),
})

/** The fields a status, rating, or review write sets, on an existing entry or a new one. */
const EntryWrite = Schema.Struct({
  edition_id: Schema.optional(Schema.Int),
  privacy_setting_id: Schema.optional(Schema.Int),
  rating: Schema.optional(Schema.NullOr(Schema.Finite)),
  review_has_spoilers: Schema.optional(Schema.Boolean),
  review_markdown: Schema.optional(Schema.String),
  reviewed_at: Schema.optional(Schema.String),
  status_id: Schema.optional(Schema.Int),
})

/** `UserBookCreateInput`: a new entry. */
const NewEntry = EntryWrite.mapFields(Struct.assign({ book_id: Schema.Int }))

/** The Slate document Hardcover derives a review from. */
const ReviewSlate = Schema.Struct({
  document: Schema.Struct({ children: Schema.Array(Schema.Unknown), object: Schema.String }),
})

/** The fields only an entry edit sets; null clears the nullable ones. */
const EditOnlyFields = {
  date_added: Schema.optional(Schema.String),
  edition_id: Schema.optional(Schema.NullOr(Schema.Int)),
  first_started_reading_date: Schema.optional(Schema.String),
  last_read_date: Schema.optional(Schema.String),
  private_notes: Schema.optional(Schema.NullOr(Schema.String)),
  read_count: Schema.optional(Schema.Int),
  recommended_by: Schema.optional(Schema.NullOr(Schema.String)),
  recommended_for: Schema.optional(Schema.NullOr(Schema.String)),
  review_slate: Schema.optional(ReviewSlate),
}

/** `UserBookUpdateInput`: the fields an entry write or edit may change. */
const EntryUpdate = EntryWrite.mapFields(Struct.assign(EditOnlyFields))

/** `DatesReadInput`: a reading session's dates, progress, and edition. */
const ReadDates = Schema.Struct({
  edition_id: Schema.optional(Schema.Int),
  finished_at: Schema.optional(Schema.String),
  progress_pages: Schema.optional(Schema.Int),
  progress_seconds: Schema.optional(Schema.Int),
  started_at: Schema.optional(Schema.String),
})

const InsertedEntry = Schema.Struct({ insert_user_book: BookPayload })
const UpdatedEntry = Schema.Struct({ update_user_book: BookPayload })
const RemovedEntry = Schema.Struct({ delete_user_book: Schema.NullOr(DeletedBook) })
const InsertedRead = Schema.Struct({ insert_user_book_read: ReadPayload })
const UpdatedRead = Schema.Struct({ update_user_book_read: ReadPayload })
const RemovedRead = Schema.Struct({ delete_user_book_read: DeletedRead })

const PageVariables = { limit: Schema.Int, offset: Schema.Int, orderBy: Schema.Array(EntryOrder), userId: Schema.Int }

const libraryRows = run(
  GraphQL.query("Library", {
    document: `query Library($userId: Int!, $limit: Int!, $offset: Int!, $orderBy: [user_books_order_by!]!) {
    user_books(where: {user_id: {_eq: $userId}}, order_by: $orderBy, limit: $limit, offset: $offset) { ${ENTRY_FIELDS} }
    user_books_aggregate(where: {user_id: {_eq: $userId}}) { aggregate { count } }
  }`,
    result: LibraryPage,
    variables: PageVariables,
  }),
)

const libraryRowsByStatus = run(
  GraphQL.query("Library", {
    document: `query Library($userId: Int!, $statusId: Int!, $limit: Int!, $offset: Int!, $orderBy: [user_books_order_by!]!) {
    user_books(where: {user_id: {_eq: $userId}, status_id: {_eq: $statusId}}, order_by: $orderBy, limit: $limit, offset: $offset) { ${ENTRY_FIELDS} }
    user_books_aggregate(where: {user_id: {_eq: $userId}, status_id: {_eq: $statusId}}) { aggregate { count } }
  }`,
    result: LibraryPage,
    variables: Struct.assign(PageVariables, { statusId: Schema.Int }),
  }),
)

const currentlyReadingRows = run(
  GraphQL.query("CurrentlyReading", {
    document: `query CurrentlyReading($userId: Int!) {
  user_books(where: {user_id: {_eq: $userId}, status_id: {_eq: 2}}, order_by: {updated_at: desc_nulls_last}) {
    id book_id edition_id
    book { id title slug pages audio_seconds contributions(limit: 2) { author { name } } }
    edition { id pages audio_seconds reading_format_id }
    user_book_reads(where: {finished_at: {_is_null: true}}, order_by: {id: desc}, limit: 1) { ${READ_FIELDS} }
  }
}`,
    result: BookRows,
    variables: { userId: Schema.Int },
  }),
)

const reviewRows = run(
  GraphQL.query("Reviews", {
    document: `query Reviews($userId: Int!, $limit: Int!, $offset: Int!) {
  user_books(where: {user_id: {_eq: $userId}, has_review: {_eq: true}}, order_by: [{reviewed_at: desc_nulls_last}, {id: desc}],
             limit: $limit, offset: $offset) {
    id book_id rating review_markdown review_has_spoilers reviewed_at privacy_setting_id book { id title slug contributions(limit: 2) { author { name } } }
  }
}`,
    result: BookRows,
    variables: { limit: Schema.Int, offset: Schema.Int, userId: Schema.Int },
  }),
)

const entryOf = run(
  GraphQL.query("LibraryEntry", {
    document: `query LibraryEntry($userId: Int!, $bookId: Int!) {
  user_books(where: {user_id: {_eq: $userId}, book_id: {_eq: $bookId}}, limit: 1) {
    ${ENTRY_FIELDS}
    user_book_reads(order_by: {id: desc}) { ${READ_FIELDS} edition { id pages audio_seconds } }
  }
}`,
    result: EntryRows,
    variables: { bookId: Schema.Int, userId: Schema.Int },
  }),
)

const readOf = run(
  GraphQL.query("Read", {
    document: `query Read($id: Int!) { user_book_reads_by_pk(id: $id) { ${READ_FIELDS} user_book { id user_id book_id } } }`,
    result: ReadLookup,
    variables: { id: Schema.Int },
  }),
)

const addUserBook = run(
  GraphQL.mutation("AddToLibrary", {
    document: `mutation AddToLibrary($object: UserBookCreateInput!) {
  insert_user_book(object: $object) { id error user_book { ${ENTRY_FIELDS} } }
}`,
    result: InsertedEntry,
    variables: { object: NewEntry },
  }),
)

const updateUserBook = run(
  GraphQL.mutation("UpdateLibraryEntry", {
    document: `mutation UpdateLibraryEntry($id: Int!, $object: UserBookUpdateInput!) {
  update_user_book(id: $id, object: $object) { id error user_book { ${ENTRY_FIELDS} } }
}`,
    result: UpdatedEntry,
    variables: { id: Schema.Int, object: EntryUpdate },
  }),
)

const deleteUserBook = run(
  GraphQL.mutation("Remove", {
    document: "mutation Remove($id: Int!) { delete_user_book(id: $id) { id book_id } }",
    result: RemovedEntry,
    variables: { id: Schema.Int },
  }),
)

const addUserBookRead = run(
  GraphQL.mutation("AddRead", {
    document: `mutation AddRead($userBookId: Int!, $read: DatesReadInput!) {
  insert_user_book_read(user_book_id: $userBookId, user_book_read: $read) { id error user_book_read { ${READ_FIELDS} } }
}`,
    result: InsertedRead,
    variables: { read: ReadDates, userBookId: Schema.Int },
  }),
)

const updateUserBookRead = run(
  GraphQL.mutation("UpdateRead", {
    document: `mutation UpdateRead($id: Int!, $read: DatesReadInput!) {
  update_user_book_read(id: $id, object: $read) { id error user_book_read { ${READ_FIELDS} } }
}`,
    result: UpdatedRead,
    variables: { id: Schema.Int, read: ReadDates },
  }),
)

const deleteUserBookRead = run(
  GraphQL.mutation("DeleteRead", {
    document: "mutation DeleteRead($id: Int!) { delete_user_book_read(id: $id) { id error } }",
    result: RemovedRead,
    variables: { id: Schema.Int },
  }),
)

const ownedRowsOf = run(
  GraphQL.query("Owned", {
    document: `query Owned($userId: Int!, $editionId: Int!) {
  lists(where: {user_id: {_eq: $userId}, slug: {_eq: "owned"}}) { list_books(where: {edition_id: {_eq: $editionId}}) { id } }
}`,
    result: OwnedLists,
    variables: { editionId: Schema.Int, userId: Schema.Int },
  }),
)

const markOwned = run(
  GraphQL.mutation("Owned", {
    document: "mutation Owned($id: Int!) { edition_owned(id: $id) { id list_book { id list_id } } }",
    result: OwnedChange,
    variables: { id: Schema.Int },
  }),
)

const deleteListBook = run(
  GraphQL.mutation("Unown", {
    document: "mutation Unown($id: Int!) { delete_list_book(id: $id) { id list_id } }",
    result: Schema.Unknown,
    variables: { id: Schema.Int },
  }),
)

type EntryOrderBy = typeof EntryOrder.Type
type EntryChanges = typeof EntryWrite.Type
type EntryEdit = typeof EntryUpdate.Type
type NewEntryInput = typeof NewEntry.Type
type ReadChanges = typeof ReadDates.Type
/** Pages or seconds read, whichever the request gave or the edition measures. */
type ReadProgress = Pick<ReadChanges, "progress_pages" | "progress_seconds">

/**
 * Application module, not a public API.
 * @internal
 */
export {
  currentlyReadingRows,
  entryOf,
  addUserBook,
  addUserBookRead,
  libraryRows,
  libraryRowsByStatus,
  markOwned,
  ownedRowsOf,
  readOf,
  deleteUserBook,
  deleteListBook,
  deleteUserBookRead,
  reviewRows,
  updateUserBook,
  updateUserBookRead,
}
/**
 * Application module, not a public API.
 * @internal
 */
export type { EntryChanges, EntryEdit, EntryOrderBy, NewEntryInput, ReadChanges, ReadProgress }
