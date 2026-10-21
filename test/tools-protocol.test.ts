/**
 * The sessionful 2025 revisions of the MCP server: initialization hands out a
 * session (and, from 2025-11-25, the server's icons), and the tool list only
 * shows what the connection's scopes allow.
 */
import { Array as Arr, Effect, ManagedRuntime, Option, Schema, String as Str, Struct, pipe } from "effect"
import { MCP_ORIGIN, post, toolHarness } from "#test/tools-harness.ts"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { ToolHarness } from "#test/tools-harness.ts"

const SESSION_PROTOCOL = "2025-06-18"
const ICONS_PROTOCOL = "2025-11-25"
const SITE_PUBLIC = new URL("../site/public", import.meta.url).pathname
const REGISTRY_ENTRY = new URL("../server.json", import.meta.url).pathname
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
const Icon = Schema.Struct({ src: Schema.String })
const ServerInfo = Schema.Struct({ icons: Schema.Array(Icon), version: Schema.String, websiteUrl: Schema.String })
/** The parts of the MCP Registry entry that must agree with what the server reports. */
const RegistryEntry = Schema.Struct({
  icons: Schema.Array(Icon),
  remotes: Schema.Array(Schema.Struct({ url: Schema.String })),
  version: Schema.String,
  websiteUrl: Schema.String,
})
const IconsMessage = Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ serverInfo: ServerInfo }) }))
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

const RegistryEntryJson = Schema.fromJsonString(RegistryEntry)
const readRegistryEntry = Effect.promise(() => Bun.file(REGISTRY_ENTRY).text())
const registryEntry = readRegistryEntry.pipe(Effect.flatMap(Schema.decodeEffect(RegistryEntryJson)))

/**
 * The paths of some URLs, so entries pointing at another origin still compare.
 * @param {ReadonlyArray} items Things with a `src` or `url`.
 * @returns {ReadonlyArray<string>} Their paths.
 */
const urlPaths = (items: ReadonlyArray<Readonly<{ src: string } | { url: string }>>): ReadonlyArray<string> =>
  pipe(
    items,
    Arr.map((item) => new URL("src" in item ? item.src : item.url).pathname),
  )

const servesIcons = Effect.gen(function* servesIcons() {
  const init = yield* post({
    body: {
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: ICONS_PROTOCOL },
    },
    headers: {},
  })
  const message = yield* messageText(init).pipe(Effect.flatMap(Schema.decodeEffect(IconsMessage)))
  const served = yield* pipe(
    message.result.serverInfo.icons,
    Effect.forEach((icon) =>
      Effect.promise(() => Bun.file(`${SITE_PUBLIC}${new URL(icon.src).pathname}`).exists()).pipe(
        Effect.map((exists) => ({ exists, src: icon.src })),
      ),
    ),
  )
  expect(served).toEqual([
    { exists: true, src: `${MCP_ORIGIN}/icon-48.png` },
    { exists: true, src: `${MCP_ORIGIN}/icon-512.png` },
  ])
  const entry = yield* registryEntry
  expect({
    icons: urlPaths(entry.icons),
    mcpPath: urlPaths(entry.remotes),
    version: entry.version,
    websiteUrl: entry.websiteUrl,
  }).toEqual({
    icons: urlPaths(message.result.serverInfo.icons),
    mcpPath: ["/mcp"],
    version: message.result.serverInfo.version,
    websiteUrl: message.result.serverInfo.websiteUrl,
  })
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

  test("2025-11-25 clients get icons that the site serves from the server's own origin, matching server.json", () =>
    runtime.runPromise(servesIcons))
})
