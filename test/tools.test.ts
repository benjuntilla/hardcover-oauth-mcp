/**
 * Calls every tool through the real Effect MCP server with a fake Hardcover
 * client that validates each GraphQL document and its variables against
 * Hardcover's published schema, then answers with plausible data.
 */
import { Array as Arr, Effect, ManagedRuntime, Option, Record as Rec, Schema, String as Str, pipe } from "effect"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { callTool, firstText, succeeded } from "#test/tools-call.ts"
import { clearCalls, firstSent, sent, toolHarness } from "#test/tools-harness.ts"
import { SAMPLES } from "#test/tools-samples.ts"
import { SUPPORTED_SCOPES } from "#src/hardcover/scopes.ts"
import { TOOL_POLICIES } from "#src/mcp/server.ts"
import type { ToolCallFailed } from "#test/tools-call.ts"
import type { ToolHarness } from "#test/tools-harness.ts"

const NO_CALLS = 0
const SEQUEL_ID = 101

const runtime = ManagedRuntime.make(toolHarness(new Set(SUPPORTED_SCOPES)))

const callsCleanly = (
  name: string,
  args: Readonly<Record<string, unknown>>,
): Effect.Effect<void, ToolCallFailed | Schema.SchemaError, ToolHarness> =>
  Effect.gen(function* callWithoutError() {
    const result = yield* callTool(name, args).pipe(Effect.flatMap(succeeded))
    expect(result.structuredContent).toBeDefined()
  })

const progressByPercent = Effect.gen(function* progressByPercent() {
  yield* callTool("hardcover_update_progress", { bookId: 100, percent: 50 })
  const update = yield* firstSent("update_user_book_read")
  expect(Option.getOrUndefined(update)?.read).toMatchObject({ edition_id: 10, progress_pages: 150, started_at: "2026-01-02" })
})

const listPrivacy = Effect.gen(function* listPrivacy() {
  yield* clearCalls
  yield* callTool("hardcover_create_list", { name: "Beach reads" })
  yield* callTool("hardcover_create_list", { name: "Secret", privacy: "private" })
  const [plain, secret] = yield* sent("insert_list")
  expect(plain?.variables.object).not.toHaveProperty("privacy_setting_id")
  expect(secret?.variables.object).toMatchObject({ privacy_setting_id: 3 })
})

const journalPrivacy = Effect.gen(function* journalPrivacy() {
  yield* clearCalls
  yield* callTool("hardcover_add_journal_entry", { bookId: 100, text: "Loved it" })
  const byDefault = yield* firstSent("insert_reading_journal")
  expect(Option.getOrUndefined(byDefault)?.object).toMatchObject({ privacy_setting_id: 2 })
  yield* clearCalls
  yield* callTool("hardcover_add_journal_entry", { bookId: 100, privacy: "public", text: "Loved it" })
  expect(yield* sent("DefaultPrivacy")).toHaveLength(NO_CALLS)
  const given = yield* firstSent("insert_reading_journal")
  expect(Option.getOrUndefined(given)?.object).toMatchObject({ privacy_setting_id: 1 })
})

const goalPrivacy = Effect.gen(function* goalPrivacy() {
  yield* clearCalls
  yield* callTool("hardcover_create_goal", { endDate: "2026-12-31", privacy: "private", startDate: "2026-01-01", target: 10 })
  const update = yield* firstSent("update_goal")
  expect(Option.getOrUndefined(update)?.object).toMatchObject({ goal: 10, privacy_setting_id: 3 })
})

const ownership = Effect.gen(function* ownership() {
  const already = yield* callTool("hardcover_set_owned", { editionId: 11, owned: true })
  expect(already.structuredContent).toEqual({ changed: false, owned: true })
  const removed = yield* callTool("hardcover_set_owned", { editionId: 11, owned: false })
  expect(removed.structuredContent).toEqual({ changed: true, owned: false })
  expect(yield* sent("edition_owned")).toHaveLength(NO_CALLS)
  expect(Option.getOrUndefined(yield* firstSent("delete_list_book"))).toEqual({ id: 77 })
})

const rawRouting = Effect.gen(function* rawRouting() {
  const mutate = yield* callTool("hardcover_mutate", { query: "mutation { delete_goal(id: 4) { id } }" })
  expect(mutate.isError).toBe(true)
  expect(firstText(mutate)).toContain("hardcover_delete")
  const catalog = yield* callTool("hardcover_mutate", { query: "mutation { book_normalize(id: 1) { id } }" })
  expect(firstText(catalog)).toContain("hardcover_catalog_edit")
  const disabled = yield* callTool("hardcover_query", { query: 'query { books(where: {title: {_ilike: "%dune%"}}) { id } }' })
  expect(firstText(disabled)).toContain("_ilike")
})

const schemaRejections = Effect.gen(function* schemaRejections() {
  const unknownField = yield* callTool("hardcover_query", { query: "query { books_by_pk(id: 100) { id no_such_field } }" })
  expect(firstText(unknownField)).toContain("no_such_field")
  const wrongVariable = yield* callTool("hardcover_query", {
    query: "query($id: Int!) { books_by_pk(id: $id) { id } }",
    variables: { id: "abc" },
  })
  expect(firstText(wrongVariable)).toContain("Schema validation failed")
})

const trendingRows = Effect.gen(function* trendingRows() {
  const result = yield* callTool("hardcover_trending_books", { period: "week" })
  expect(result.structuredContent?.books).toEqual([{ id: 100, slug: "dune", title: "Dune" }])
})

const reorder = Effect.gen(function* reorder() {
  const result = yield* callTool("hardcover_reorder_list", { bookIds: [SEQUEL_ID], listId: 3 })
  expect(result.structuredContent?.order).toEqual([
    { bookId: 101, position: 1 },
    { bookId: 100, position: 2 },
  ])
  const updates = yield* firstSent("update_list_books_many")
  expect(Option.getOrUndefined(updates)?.updates).toEqual([
    { _set: { position: 1 }, where: { id: { _eq: 32 } } },
    { _set: { position: 2 }, where: { id: { _eq: 31 } } },
  ])
})

const FoundOperations = Schema.Struct({ operations: Schema.Array(Schema.Struct({ kind: Schema.String, name: Schema.String })) })

const findOperations = (
  args: Readonly<Record<string, unknown>>,
): Effect.Effect<typeof FoundOperations.Type, ToolCallFailed | Schema.SchemaError, ToolHarness> =>
  callTool("hardcover_find_operations", args).pipe(
    Effect.map((result) => result.structuredContent),
    Effect.flatMap(Schema.decodeUnknownEffect(FoundOperations)),
  )

const bestMatch = (found: typeof FoundOperations.Type): Option.Option<string> =>
  pipe(
    found.operations,
    Arr.head,
    Option.map((operation) => operation.name),
  )

const operationSearch = Effect.gen(function* operationSearch() {
  const exact = yield* findOperations({ search: "user_books" })
  expect(bestMatch(exact)).toEqual(Option.some("user_books"))
  const phrased = yield* findOperations({ kind: "mutation", search: "add a book to a list" })
  expect(bestMatch(phrased)).toEqual(Option.some("insert_list_book"))
  expect(
    pipe(
      phrased.operations,
      Arr.every((operation) => operation.kind === "mutation"),
    ),
  ).toBe(true)
})

const closestType = (name: string): Effect.Effect<string, ToolCallFailed | Schema.SchemaError, ToolHarness> =>
  Effect.map(callTool("hardcover_describe_type", { name }), firstText)

const typeSuggestions = Effect.gen(function* typeSuggestions() {
  expect(yield* closestType("book")).toStartWith("No type named book. Similar: books, ")
  expect(yield* closestType("UserBook")).toStartWith("No type named UserBook. Similar: user_books, ")
  expect(yield* closestType("books_by_pk")).toStartWith("No type named books_by_pk. Similar: books")
})

/** Tool behaviours beyond calling cleanly, each with what it checks. */
const BEHAVIOURS = [
  ["progress by percent converts with the edition's page count", progressByPercent],
  [
    "privacy is left to Hardcover unless given; journal entries take the account default",
    listPrivacy.pipe(Effect.andThen(journalPrivacy), Effect.andThen(goalPrivacy)),
  ],
  ["ownership follows the Owned list", ownership],
  ["raw tools route deletions and catalog edits to their own tools", rawRouting],
  ["the fake client rejects GraphQL that doesn't match the schema", schemaRejections],
  ["reorder only moves rows whose position changes", reorder],
  ["trending books keep the fields Hardcover returns", trendingRows],
  ["operation search puts exact names first and understands request verbs", operationSearch],
  ["a missing type suggests the closest names first", typeSuggestions],
] as const

describe("tools", () => {
  beforeEach(() => runtime.runPromise(clearCalls))

  afterAll(() => runtime.dispose())

  test("every tool has a sample", () => {
    const tools = pipe(Arr.fromIterable(TOOL_POLICIES.keys()), Arr.sortBy(Str.Order))
    expect(tools).toEqual(pipe(Rec.keys(SAMPLES), Arr.sortBy(Str.Order)))
  })

  test.each(Rec.toEntries(SAMPLES))("%s", (name, args) => runtime.runPromise(callsCleanly(name, args)))

  test.each(BEHAVIOURS)("%s", (_description, behaviour) => runtime.runPromise(behaviour))
})
