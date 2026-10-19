/**
 * The MCP handler under test, built once per test file by its runtime: the
 * real Effect MCP server over a session whose Hardcover client is the
 * schema-validating fake.
 */
import { Array as Arr, Context, Effect, Layer, Option, Schema, Struct } from "effect"
import type { GraphQLCall } from "#test/tools-fake.ts"
import { ME } from "#test/tools-fixtures.ts"
import { makeFakeHardcover } from "#test/tools-fake.ts"
import { makeMcpHandler } from "#src/mcp/server.ts"

/** A self-hosted deployment's address, so URLs that assume localhost or the hosted server fail the tests. */
const MCP_ORIGIN = "https://mcp.example.test"
const MCP_URL = `${MCP_ORIGIN}/mcp`
const ACCEPT = "application/json, text/event-stream"
const CONTENT_JSON = "application/json"

class ToolHarness extends Context.Service<
  ToolHarness,
  {
    /** Every GraphQL request since the last `clear`, oldest first. */
    readonly calls: Effect.Effect<ReadonlyArray<GraphQLCall>>
    readonly clear: Effect.Effect<void>
    readonly post: (request: Request) => Effect.Effect<Response>
  }
>()("hardcover-oauth-mcp/test/tools-harness/ToolHarness") {}

const JsonText = Schema.fromJsonString(Schema.Unknown)

/**
 * The harness for a connection granted `scopes`, disposing its handler with the runtime.
 * @param {ReadonlySet<string>} scopes The scopes on the connection.
 * @returns {Layer.Layer<ToolHarness>} The harness layer.
 */
const toolHarness = (scopes: ReadonlySet<string>): Layer.Layer<ToolHarness> =>
  Layer.effect(
    ToolHarness,
    Effect.gen(function* makeHarness() {
      const fake = yield* makeFakeHardcover
      const session = { graphql: fake.graphql, hcUserId: ME, librarianRoles: ["librarian"], scopes, supporter: true, username: "reader" }
      const mcp = yield* Effect.acquireRelease(
        Effect.sync(() => makeMcpHandler({ origin: MCP_ORIGIN, session })),
        (handler) => Effect.promise(() => handler.dispose()),
      )
      return { calls: fake.calls, clear: fake.clear, post: (request) => Effect.promise(() => mcp.handler(request)) }
    }),
  )

/**
 * Posts one JSON-RPC message to `/mcp`.
 * @param {object} message The message and any extra headers.
 * @param {unknown} message.body The JSON-RPC message.
 * @param {Readonly<Record<string, string>>} message.headers Headers beyond `accept` and `content-type`.
 * @returns {Effect.Effect<Response, Schema.SchemaError, ToolHarness>} The handler's response.
 */
const post = (message: {
  readonly body: unknown
  readonly headers: Readonly<Record<string, string>>
}): Effect.Effect<Response, Schema.SchemaError, ToolHarness> =>
  Effect.gen(function* postMessage() {
    const body = yield* Schema.encodeEffect(JsonText)(message.body)
    const headers = Struct.assign({ accept: ACCEPT, "content-type": CONTENT_JSON }, message.headers)
    return yield* ToolHarness.use((harness) => harness.post(new Request(MCP_URL, { body, headers, method: "POST" })))
  })

/**
 * The GraphQL requests since the last `clearCalls` whose document mentions `fragment`.
 * @param {string} fragment Text the document must contain, such as a root field.
 * @returns {Effect.Effect<ReadonlyArray<GraphQLCall>, never, ToolHarness>} The matching requests, oldest first.
 */
const sent = (fragment: string): Effect.Effect<ReadonlyArray<GraphQLCall>, never, ToolHarness> =>
  ToolHarness.use((harness) => harness.calls).pipe(Effect.map(Arr.filter((call) => call.query.includes(fragment))))

/**
 * The variables of the first GraphQL request since the last `clearCalls` whose document mentions `fragment`.
 * @param {string} fragment Text the document must contain, such as a root field.
 * @returns {Effect.Effect<Option.Option<Readonly<Record<string, unknown>>>, never, ToolHarness>} Its variables, if one was sent.
 */
const firstSent = (fragment: string): Effect.Effect<Option.Option<Readonly<Record<string, unknown>>>, never, ToolHarness> =>
  sent(fragment).pipe(Effect.map((calls) => Option.map(Arr.head(calls), (call) => call.variables)))

const clearCalls: Effect.Effect<void, never, ToolHarness> = ToolHarness.use((harness) => harness.clear)

export { MCP_ORIGIN, clearCalls, firstSent, post, sent, toolHarness }
export type { ToolHarness }
