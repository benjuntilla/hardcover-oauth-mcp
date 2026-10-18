/**
 * The sessionful 2025 revisions of the MCP server: initialization hands out a
 * session, and the tool list only shows what the connection's scopes allow.
 */
import { Array as Arr, Effect, ManagedRuntime, Option, Schema, String as Str, Struct, pipe } from "effect"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { post, toolHarness } from "#test/tools-harness.ts"
import type { ToolHarness } from "#test/tools-harness.ts"

const SESSION_PROTOCOL = "2025-06-18"
const ACCEPTED = 202
const NOT_FOUND = 404
const DATA_PREFIX = "data:"
const JSON_START = "{"
const JSON_NULL_TEXT = "null"

const runtime = ManagedRuntime.make(toolHarness(new Set(["read:me:content", "read:catalog"])))

const Initialized = Schema.Struct({ protocolVersion: Schema.String })
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) })
const ToolCalled = Schema.Struct({ isError: Schema.Boolean })
const InitializeMessage = Schema.fromJsonString(Schema.Struct({ result: Initialized }))
const ToolListMessage = Schema.fromJsonString(Schema.Struct({ result: ToolList }))
const ToolCallMessage = Schema.fromJsonString(Schema.Struct({ result: ToolCalled }))

type SessionHeaders = Readonly<Record<string, string>>

/**
 * The JSON-RPC message in a JSON or single-event SSE body, as JSON text.
 * @param {Response} response The handler's response.
 * @returns {Effect.Effect<string>} The message's JSON text.
 */
const messageText = (response: Response): Effect.Effect<string> =>
  Effect.promise(() => response.text()).pipe(
    Effect.map((text) =>
      pipe(text, Str.startsWith(JSON_START))
        ? text
        : pipe(
            text,
            Str.split("\n"),
            Arr.findFirst(Str.startsWith(DATA_PREFIX)),
            Option.map(Str.slice(DATA_PREFIX.length)),
            Option.getOrElse(() => JSON_NULL_TEXT),
          ),
    ),
  )

const initialize = Effect.gen(function* initialize() {
  const init = yield* post({
    body: {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: SESSION_PROTOCOL },
    },
    headers: {},
  })
  const sessionId = pipe(
    Option.fromNullishOr(init.headers.get("mcp-session-id")),
    Option.getOrElse(() => ""),
  )
  expect(sessionId).toBeTruthy()
  const initialized = yield* messageText(init).pipe(Effect.flatMap(Schema.decodeEffect(InitializeMessage)))
  expect(initialized.result.protocolVersion).toBe(SESSION_PROTOCOL)
  return { "mcp-protocol-version": SESSION_PROTOCOL, "mcp-session-id": sessionId }
})

const listsScopedTools = (inSession: SessionHeaders): Effect.Effect<void, Schema.SchemaError, ToolHarness> =>
  Effect.gen(function* listScopedTools() {
    const initialized = yield* post({ body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: inSession })
    expect(initialized.status).toBe(ACCEPTED)
    const listed = yield* post({ body: { id: 2, jsonrpc: "2.0", method: "tools/list" }, headers: inSession })
    const list = yield* messageText(listed).pipe(Effect.flatMap(Schema.decodeEffect(ToolListMessage)))
    const names = pipe(
      list.result.tools,
      Arr.map((tool) => tool.name),
    )
    expect(names).toContain("hardcover_search")
    expect(names).toContain("hardcover_query")
    expect(names).not.toContain("hardcover_set_status")
    expect(names).not.toContain("hardcover_mutate")
  })

const callsInSession = (inSession: SessionHeaders): Effect.Effect<void, Schema.SchemaError, ToolHarness> =>
  Effect.gen(function* callInSession() {
    const params = { arguments: { id: 100 }, name: "hardcover_get_book" }
    const called = yield* post({ body: { id: 3, jsonrpc: "2.0", method: "tools/call", params }, headers: inSession })
    const call = yield* messageText(called).pipe(Effect.flatMap(Schema.decodeEffect(ToolCallMessage)))
    expect(call.result.isError).toBe(false)
    const unknownSession = Struct.assign(inSession, { "mcp-session-id": "nope" })
    const unknown = yield* post({ body: { id: 4, jsonrpc: "2.0", method: "tools/list" }, headers: unknownSession })
    expect(unknown.status).toBe(NOT_FOUND)
  })

const sessionFlow = Effect.gen(function* sessionFlow() {
  const inSession = yield* initialize
  yield* listsScopedTools(inSession)
  yield* callsInSession(inSession)
})

describe("protocol", () => {
  beforeAll(() => runtime.context())

  afterAll(() => runtime.dispose())

  test("2025-06-18 clients get a session, and only the tools their scopes allow", () => runtime.runPromise(sessionFlow))
})
