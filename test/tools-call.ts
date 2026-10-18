/** Calls one tool over the sessionless 2026-07-28 revision and reads its result. */
import { Array as Arr, Effect, Function, Option, Schema, pipe } from "effect"
import type { ToolHarness } from "#test/tools-harness.ts"
import { post } from "#test/tools-harness.ts"

const PROTOCOL = "2026-07-28"
const TOOL_CALL = "tools/call"
const REQUEST_ID = 1
const DATA_FIRST_ARITY = 2

/** A tool call that answered with a JSON-RPC error, or a tool error where success was expected. */
class ToolCallFailed extends Schema.TaggedError<ToolCallFailed, { readonly brand: unique symbol }>()("ToolCallFailed", {
  message: Schema.String,
}) {}

const ToolResult = Schema.Struct({
  content: Schema.Array(Schema.Struct({ text: Schema.String })),
  isError: Schema.Boolean,
  structuredContent: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})

type ToolResultValue = typeof ToolResult.Type

const RpcError = Schema.Struct({ message: Schema.String })

const ToolResponse = Schema.fromJsonString(Schema.Struct({ error: Schema.optionalKey(RpcError), result: Schema.optionalKey(ToolResult) }))

const META = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
}

const toolResult = (response: Response): Effect.Effect<ToolResultValue, ToolCallFailed | Schema.SchemaError> =>
  Effect.gen(function* readResult() {
    const decoded = yield* Effect.promise(() => response.text()).pipe(Effect.flatMap(Schema.decodeEffect(ToolResponse)))
    const failure = ToolCallFailed.make({ message: `JSON-RPC error: ${decoded.error?.message ?? "no result"}` })
    return yield* Effect.fromOption(Option.fromNullishOr(decoded.result)).pipe(Effect.mapError(() => failure))
  })

/**
 * Calls a tool over the sessionless 2026-07-28 revision.
 * @param {string} name The tool.
 * @param {Readonly<Record<string, unknown>>} args Its arguments.
 * @returns {Effect.Effect<ToolResultValue, ToolCallFailed | Schema.SchemaError, ToolHarness>} The tool result, error or not.
 */
const callTool: {
  (
    args: Readonly<Record<string, unknown>>,
  ): (name: string) => Effect.Effect<ToolResultValue, ToolCallFailed | Schema.SchemaError, ToolHarness>
  (name: string, args: Readonly<Record<string, unknown>>): Effect.Effect<ToolResultValue, ToolCallFailed | Schema.SchemaError, ToolHarness>
} = Function.dual(
  DATA_FIRST_ARITY,
  (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.Effect<ToolResultValue, ToolCallFailed | Schema.SchemaError, ToolHarness> =>
    post({
      body: { id: REQUEST_ID, jsonrpc: "2.0", method: TOOL_CALL, params: { _meta: META, arguments: args, name } },
      headers: { "mcp-method": TOOL_CALL, "mcp-name": name, "mcp-protocol-version": PROTOCOL },
    }).pipe(Effect.flatMap(toolResult)),
)

/**
 * Fails with the tool's error text, the way a thrown error would, unless the call succeeded.
 * @param {ToolResultValue} result The tool result.
 * @returns {Effect.Effect<ToolResultValue, ToolCallFailed>} The successful result.
 */
const succeeded = (result: ToolResultValue): Effect.Effect<ToolResultValue, ToolCallFailed> => {
  const text = pipe(
    result.content,
    Arr.map((item) => item.text),
    Arr.join("\n"),
  )
  return result.isError ? Effect.fail(ToolCallFailed.make({ message: text })) : Effect.succeed(result)
}

/**
 * The first content item's text, or empty.
 * @param {ToolResultValue} result The tool result.
 * @returns {string} The text.
 */
const firstText = (result: ToolResultValue): string =>
  pipe(
    Arr.head(result.content),
    Option.map((item) => item.text),
    Option.getOrElse(() => ""),
  )

export { callTool, firstText, succeeded }
export type { ToolCallFailed }
