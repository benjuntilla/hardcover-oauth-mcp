/**
 * October API additions the typed SDK resources don't cover yet: profile pins,
 * the signed-in user's settings, and matching a held import row.
 * Each one goes through the SDK client, so it gets the same auth, pacing, and errors.
 */
import { Array as Arr, Effect, Schema, pipe } from "effect"
import { Id, Json, JsonList, call } from "./common.ts"
import { Tool, Toolkit } from "effect/ai"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { Session } from "#src/mcp/session.ts"
import { hardcoverTool } from "#src/mcp/define.ts"

const PINNABLE = ["List", "Prompt", "Goal", "Group", "Vibe", "GroupEvent", "Location"] as const
const MIN_PIN_IDS = 1
const NO_MISSING = 0
const PinnableId = Id("Id of the list, prompt, goal, book club, vibe, event, or location.")
const PinnedItemId = Id("Id of the pinned item.")
const PinId = Id("Pin id.")
const ImportBookId = Id("Book to match the row to.")
const ImportEditionId = Schema.optionalKey(Id("Edition, when the row names one."))
const ImportResultId = Id("collection_import_results id.")
const PinIds = Schema.Array(PinId).check(Schema.isMinLength(MIN_PIN_IDS))

interface PinRow {
  readonly id: number
  readonly pinnable_id: number
  readonly pinnable_type: string
  readonly position: number
}

const ListPins = hardcoverTool({
  description:
    "Items pinned to the user's profile, in display order. Supported types: List, Prompt, Goal, Group, Vibe, GroupEvent, Location.",
  kind: "read",
  name: "hardcover_list_pins",
  parameters: Tool.EmptyParams,
  scopes: ["read:me:content"],
  success: Schema.Struct({ pins: JsonList }),
  title: "List profile pins",
})

const PinItem = hardcoverTool({
  description: "Pins an item to the user's profile. Position is assigned by Hardcover.",
  kind: "create",
  name: "hardcover_pin_item",
  parameters: Schema.Struct({
    pinnableId: PinnableId,
    pinnableType: Schema.Literals(PINNABLE),
  }),
  scopes: ["write:library"],
  success: Schema.Struct({ pin: Json }),
  title: "Pin to your profile",
})

const UnpinItem = hardcoverTool({
  description: "Removes a pin from the user's profile.",
  kind: "delete",
  name: "hardcover_unpin_item",
  parameters: Schema.Struct({
    pinnableId: PinnedItemId,
    pinnableType: Schema.Literals(PINNABLE),
  }),
  scopes: ["write:library"],
  success: Schema.Struct({ removed: Schema.Boolean }),
  title: "Remove a profile pin",
})

const ReorderPins = hardcoverTool({
  description: "Sets the display order of the user's profile pins. Pass every pin id, first to last.",
  kind: "update",
  name: "hardcover_reorder_pins",
  parameters: Schema.Struct({ pinIds: PinIds }),
  scopes: ["write:library"],
  success: Schema.Struct({ pins: JsonList }),
  title: "Reorder profile pins",
})

const UserSettings = hardcoverTool({
  description: "The signed-in user's settings. Labs projects already store some of theirs here.",
  kind: "read",
  name: "hardcover_user_settings",
  parameters: Tool.EmptyParams,
  scopes: ["read:me:content"],
  success: Schema.Struct({ settings: Json }),
  title: "Read your settings",
})

const MatchImport = hardcoverTool({
  description:
    "Matches one unmatched CSV import row to an existing book, optionally a specific edition. " +
    "collection_import_results.state can no longer be updated directly.",
  kind: "update",
  name: "hardcover_match_import",
  parameters: Schema.Struct({
    bookId: ImportBookId,
    editionId: ImportEditionId,
    resultId: ImportResultId,
  }),
  scopes: ["read:account", "write:library"],
  success: Schema.Struct({ result: Json }),
  title: "Match an import row",
})

const CreateImportedBook = hardcoverTool({
  description: "Creates a book from one unmatched import row instead of matching it to an existing one.",
  kind: "create",
  name: "hardcover_create_imported_book",
  parameters: Schema.Struct({ resultId: ImportResultId }),
  scopes: ["read:account", "write:library"],
  success: Schema.Struct({ result: Json }),
  title: "Create a book from an import row",
})

const PINS_QUERY = `query Pins($userId: bigint!) {
  pins(where: {pinned_to_id: {_eq: $userId}, pinned_to_type: {_eq: "User"}}, order_by: {position: asc}) {
    id pinnable_id pinnable_type position
  }
}`

const pinsOf = call((hardcover) => hardcover.client.graphql<{ pins: ReadonlyArray<PinRow> }>(PINS_QUERY, { userId: hardcover.userId }))

const pinKey = (pin: PinRow): number => pin.id

const unknownPin =
  (known: ReadonlySet<number>) =>
  (id: number): boolean =>
    !known.has(id)

const movePin = (id: number, position: number): Effect.Effect<unknown, HardcoverError, Session> =>
  call((hardcover) =>
    hardcover.client.graphql(
      "mutation MovePin($id: bigint!, $position: Int!) { update_pins_by_pk(pk_columns: {id: $id}, _set: {position: $position}) { id } }",
      { id, position },
    ),
  )

const accountHandlers = {
  hardcover_create_imported_book: Effect.fn(function* createImportedBook(params: typeof CreateImportedBook.parametersSchema.Type) {
    const result = yield* call((hardcover) =>
      hardcover.client.graphql("mutation CreateImported($id: Int!) { collection_import_result_create_book(id: $id) { id } }", {
        id: params.resultId,
      }),
    )
    return { result }
  }),

  hardcover_list_pins: Effect.fn(function* listPins() {
    return { pins: (yield* pinsOf).pins }
  }),

  hardcover_match_import: Effect.fn(function* matchImport(params: typeof MatchImport.parametersSchema.Type) {
    const result = yield* call((hardcover) =>
      hardcover.client.graphql(
        "mutation MatchImport($id: Int!, $bookId: Int!, $editionId: Int) { collection_import_result_match(id: $id, book_id: $bookId, edition_id: $editionId) { id } }",
        { bookId: params.bookId, editionId: params.editionId, id: params.resultId },
      ),
    )
    return { result }
  }),

  hardcover_pin_item: Effect.fn(function* pinItem(params: typeof PinItem.parametersSchema.Type) {
    const pin = yield* call((hardcover) =>
      hardcover.client.graphql(
        "mutation Pin($type: String!, $id: Int!) { insert_pin(pinnable_type: $type, pinnable_id: $id) { id position pin { id } } }",
        { id: params.pinnableId, type: params.pinnableType },
      ),
    )
    return { pin }
  }),

  hardcover_reorder_pins: Effect.fn(function* reorderPins(params: typeof ReorderPins.parametersSchema.Type) {
    const current = yield* pinsOf
    const known = new Set(pipe(current.pins, Arr.map(pinKey)))
    const unique = new Set(params.pinIds)
    const missing = pipe(params.pinIds, Arr.filter(unknownPin(known)))
    if (
      Arr.length(missing) > NO_MISSING ||
      unique.size !== Arr.length(current.pins) ||
      Arr.length(params.pinIds) !== Arr.length(current.pins)
    ) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Pass every pin id once, first to last." })
    }
    yield* Effect.forEach(params.pinIds, movePin)
    return { pins: (yield* pinsOf).pins }
  }),

  hardcover_unpin_item: Effect.fn(function* unpinItem(params: typeof UnpinItem.parametersSchema.Type) {
    const removed = yield* call((hardcover) =>
      hardcover.client.graphql<{ delete_pin: { success: boolean } }>(
        "mutation Unpin($type: String!, $id: Int!) { delete_pin(pinnable_type: $type, pinnable_id: $id) { success } }",
        { id: params.pinnableId, type: params.pinnableType },
      ),
    )
    return { removed: removed.delete_pin.success }
  }),

  hardcover_user_settings: Effect.fn(function* userSettings() {
    const settings = yield* call((hardcover) => hardcover.client.graphql("query Settings { user_settings { contributor_role_lists } }", {}))
    return { settings }
  }),
}

const AccountToolkit = Toolkit.make(ListPins, PinItem, UnpinItem, ReorderPins, UserSettings, MatchImport, CreateImportedBook)
const AccountToolkitLive = AccountToolkit.toLayer(accountHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { AccountToolkit, AccountToolkitLive }
