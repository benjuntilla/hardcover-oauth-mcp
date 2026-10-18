/** List tool definitions. Read: read:lists. Write: write:lists. */
import { Id, Json, JsonList, Limit, Offset, Privacy } from "./common.ts"
import { Schema } from "effect"
import { Tool } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_LIST_PAGE = 50
const MAX_LIST_PAGE = 200
const MIN_POSITION = 1
const MIN_BOOKS = 1

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_POSITION))
const ListId = Id("List id.")
const BookId = Id("Book id.")
const EditionId = Id("Edition id.")
const BookIds = Schema.Array(BookId).check(Schema.isMinLength(MIN_BOOKS))

const ListLists = hardcoverTool({
  description: "The user's lists (including Hardcover's automatic ones such as Owned) with book counts, plus lists they follow.",
  kind: "read",
  name: "hardcover_list_lists",
  parameters: Tool.EmptyParams,
  scopes: ["read:lists"],
  success: Schema.Struct({ followed: JsonList, lists: JsonList }),
  title: "List your lists",
})

const GetList = hardcoverTool({
  description: "A list (the user's, or anyone's public list) with its books in order. list_book ids identify entries.",
  kind: "read",
  name: "hardcover_get_list",
  parameters: Schema.Struct({
    limit: Limit({ fallback: DEFAULT_LIST_PAGE, max: MAX_LIST_PAGE }),
    listId: ListId,
    offset: Offset,
  }),
  scopes: ["read:lists", "read:catalog"],
  success: Schema.Struct({ list: Json }),
  title: "Get a list",
})

const CreateList = hardcoverTool({
  description: "Creates a list. Ranked lists show positions. New lists can take a few minutes to appear on the website.",
  kind: "create",
  name: "hardcover_create_list",
  parameters: Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    name: Schema.NonEmptyString,
    privacy: Schema.optionalKey(Privacy),
    ranked: Schema.optionalKey(Schema.Boolean),
  }),
  scopes: ["write:lists"],
  success: Schema.Struct({ list: Json }),
  title: "Create a list",
})

const UpdateList = hardcoverTool({
  description: "Renames a list or changes its description, privacy, or ranking.",
  kind: "update",
  name: "hardcover_update_list",
  parameters: Schema.Struct({
    description: Schema.optionalKey(Schema.String),
    listId: ListId,
    name: Schema.optionalKey(Schema.NonEmptyString),
    privacy: Schema.optionalKey(Privacy),
    ranked: Schema.optionalKey(Schema.Boolean),
  }),
  scopes: ["write:lists", "read:lists"],
  success: Schema.Struct({ list: Json }),
  title: "Edit a list",
})

const DeleteList = hardcoverTool({
  description: "Deletes one of the user's lists. The books stay in the library.",
  kind: "delete",
  name: "hardcover_delete_list",
  parameters: Schema.Struct({ listId: ListId }),
  scopes: ["write:lists", "read:lists"],
  success: Schema.Struct({ deleted: Schema.Int }),
  title: "Delete a list",
})

const AddToList = hardcoverTool({
  description: "Adds a book (optionally a specific edition) to one of the user's lists, at the end unless a position is given.",
  kind: "create",
  name: "hardcover_add_to_list",
  parameters: Schema.Struct({
    bookId: BookId,
    editionId: Schema.optionalKey(EditionId),
    listId: ListId,
    position: Schema.optionalKey(Position),
  }),
  scopes: ["write:lists"],
  success: Schema.Struct({ listBook: Json }),
  title: "Add a book to a list",
})

const RemoveFromList = hardcoverTool({
  description: "Removes a book from one of the user's lists.",
  kind: "delete",
  name: "hardcover_remove_from_list",
  parameters: Schema.Struct({ bookId: BookId, listId: ListId }),
  scopes: ["write:lists", "read:lists"],
  success: Schema.Struct({ removed: Schema.Int }),
  title: "Remove a book from a list",
})

const ReorderList = hardcoverTool({
  description:
    "Sets the order of books on one of the user's lists. Pass book ids in the new order; books left out keep their relative order after them.",
  kind: "update",
  name: "hardcover_reorder_list",
  parameters: Schema.Struct({ bookIds: BookIds, listId: ListId }),
  scopes: ["write:lists", "read:lists"],
  success: Schema.Struct({ order: JsonList }),
  title: "Reorder a list",
})

/**
 * Application module, not a public API.
 * @internal
 */
export { AddToList, CreateList, DeleteList, GetList, ListLists, RemoveFromList, ReorderList, UpdateList }
