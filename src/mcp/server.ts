/**
 * The MCP server itself: Effect's Streamable HTTP server with the Hardcover
 * toolkit, speaking the sessionless 2026-07-28 revision and the sessionful
 * 2025 revisions. Each `HardcoverConnection` Durable Object runs one for its
 * connection, so 2025 sessions live in that object's memory.
 */
import { Array as Arr, Effect, ErrorReporter, Layer, Logger, Option, Record as Rec, Scheduler, pipe } from "effect"
import { HardcoverToolkit, HardcoverToolkitLive } from "#src/mcp/toolkit.ts"
import { HttpRouter, HttpServer } from "effect/http"
import { McpProtocol, McpServer, Toolkit } from "effect/ai"
import { Session } from "#src/mcp/session.ts"
import type { ToolPolicy } from "#src/mcp/define.ts"
import { toolPolicy } from "#src/mcp/define.ts"

const INSTRUCTIONS = [
  "Tools for the user's Hardcover.app account: their library, reading progress, reviews, journal, lists, goals,",
  "and the book catalog. Call hardcover_me first to learn the user's id, Supporter status, and librarian roles.",
  "Status ids: 1 Want to Read, 2 Currently Reading, 3 Read, 4 Paused, 5 Did Not Finish.",
  "Prefer the specific tools; for anything they don't cover, use hardcover_find_operations and hardcover_describe_type",
  "to look up the GraphQL schema, then hardcover_query, hardcover_mutate, or hardcover_delete.",
  "Tools whose title says (Supporter) need a paid Hardcover membership; (Librarian) needs a librarian role.",
] as const

const SERVER_INFO = {
  instructions: pipe(INSTRUCTIONS, Arr.join(" ")),
  name: "hardcover",
  title: "Hardcover",
  version: "0.1.0",
  websiteUrl: "https://github.com/benjuntilla/hardcover-oauth-mcp",
} as const

const PROTOCOLS: Arr.NonEmptyReadonlyArray<McpProtocol.ProtocolAdapter> = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
]

/** Scope requirements per tool name, for step-up challenges and per-connection tool lists. */
const TOOL_POLICIES: ReadonlyMap<string, ToolPolicy> = new Map(
  pipe(
    Rec.values(HardcoverToolkit.tools),
    Arr.flatMap((tool) => Option.match(toolPolicy(tool), { onNone: () => [], onSome: (policy) => [[tool.name, policy] as const] })),
  ),
)

/**
 * Whether a connection with `granted` scopes can use a tool.
 * @param {object} options The tool and the connection.
 * @param {ToolPolicy} options.policy The tool's policy.
 * @param {ReadonlySet<string>} options.granted The connection's scopes.
 * @returns {boolean} Whether the tool is usable.
 */
const toolAllowed = (options: { readonly policy: ToolPolicy; readonly granted: ReadonlySet<string> }): boolean =>
  pipe(
    options.policy.scopes,
    Arr.every((scope) => options.granted.has(scope)),
  ) &&
  Option.match(options.policy.anyOf, {
    onNone: () => true,
    onSome: (anyOf) =>
      pipe(
        anyOf,
        Arr.some((scope) => options.granted.has(scope)),
      ),
  })

/**
 * Defects (bugs, Hardcover responses the code doesn't understand) are the only
 * failures logged, so they show up in Workers Issues. Expected failures reach
 * the agent as tool errors instead. The message and stack carry no request data.
 */
const ReportDefects = Layer.mergeAll(
  ErrorReporter.layer([
    ErrorReporter.make(({ error }) => {
      Effect.runFork(Effect.logError("[hardcover-oauth-mcp] defect:", error))
    }),
  ]),
  Logger.layer([]),
)

/** The server fiber outlives the request that started it, so it must not schedule through that request's timers. */
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))

/**
 * A fetch handler serving `/mcp` for one connection. Only the tools its scopes
 * allow are registered, so `tools/list` shows exactly what it can call.
 * @param {Session["Service"]} session The connection.
 * @returns {ReturnType<typeof HttpRouter.toWebHandler>} The handler.
 */
const makeMcpHandler = (
  session: Session["Service"],
): { readonly handler: (request: Request) => Promise<Response>; readonly dispose: () => Promise<void> } => {
  const tools = pipe(
    Rec.values(HardcoverToolkit.tools),
    Arr.filter((tool) =>
      Option.match(Option.fromNullishOr(TOOL_POLICIES.get(tool.name)), {
        onNone: () => true,
        onSome: (policy) => toolAllowed({ granted: session.scopes, policy }),
      }),
    ),
  )
  // The handlers layer covers every tool; registration only looks up the ones in this toolkit.
  const toolkit = Toolkit.make(...tools)
  const app = McpServer.toolkit(toolkit).pipe(
    Layer.provideMerge(HardcoverToolkitLive),
    Layer.provideMerge(
      McpServer.layerHttp({
        allowSessionTermination: true,
        instructions: SERVER_INFO.instructions,
        name: SERVER_INFO.name,
        path: "/mcp",
        protocols: PROTOCOLS,
        version: SERVER_INFO.version,
        websiteUrl: SERVER_INFO.websiteUrl,
      }),
    ),
    Layer.provide(Layer.succeed(Session, session)),
    Layer.provide(HttpServer.layerServices),
    Layer.provide(ReportDefects),
    Layer.provideMerge(SyncScheduler),
  )
  return HttpRouter.toWebHandler(app, { disableLogger: true })
}

type McpHandler = ReturnType<typeof makeMcpHandler>

/**
 * Application module, not a public API.
 * @internal
 */
export { TOOL_POLICIES, makeMcpHandler, toolAllowed }
/**
 * Application module, not a public API.
 * @internal
 */
export type { McpHandler }
