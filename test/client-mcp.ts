/**
 * One MCP request, in either the 2026-07-28 or the 2025 session style, plus
 * the JSON-RPC message from a JSON or single-event SSE response.
 */
import { Array as Arr, Effect, Option, Schema, String as Str, Struct, pipe } from "effect"
import type { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { jsonBody, send, sendBodiless, textOf } from "#test/client-http.ts"

const ACCEPT = "application/json, text/event-stream"
const CONTENT_JSON = "application/json"
const DATA_PREFIX = "data:"
const DATA_START = 5
const JSON_START = "{"
const MCP_PATH = "/mcp"
const NO_MESSAGE = "null"
const PROTOCOL = "2026-07-28"
const REQUEST_ID = 1
const TOOL_CALL = "tools/call"

const META = {
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "e2e", version: "1" },
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
}

type McpResult = Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpBody.HttpBodyError | HttpClientError.HttpClientError,
  HttpClient.HttpClient
>

const mcpHeaders = (options: Readonly<{ method: string; name: Option.Option<string>; token: string }>): Record<string, string> => {
  const headers: Record<string, string> = {
    accept: ACCEPT,
    authorization: `Bearer ${options.token}`,
    "content-type": CONTENT_JSON,
    "mcp-method": options.method,
    "mcp-protocol-version": PROTOCOL,
  }
  if (Option.isSome(options.name)) {
    headers["mcp-name"] = options.name.value
  }
  return headers
}

/**
 * One 2026-07-28 MCP request.
 * @param {object} request The server, token, JSON-RPC method, and params.
 * @param {string} request.base The server origin.
 * @param {string} request.method The JSON-RPC method.
 * @param {Readonly<Record<string, unknown>>} request.params The JSON-RPC params; `_meta` is added.
 * @param {string} request.token The MCP access token.
 * @returns {McpResult} The response.
 */
const mcp = (request: {
  readonly base: string
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>> | undefined
  readonly token: string
}): McpResult =>
  Effect.gen(function* callMcp() {
    const params = request.params ?? {}
    const name = request.method === TOOL_CALL ? Option.some(String(params.name)) : Option.none()
    const body = yield* jsonBody({ id: REQUEST_ID, jsonrpc: "2.0", method: request.method, params: Struct.assign(params, { _meta: META }) })
    return yield* send({
      body,
      headers: mcpHeaders({ method: request.method, name, token: request.token }),
      method: "POST",
      url: `${request.base}${MCP_PATH}`,
    })
  })

/**
 * One request in the 2025 protocol style; pass `mcp-session-id` and `mcp-protocol-version` after initializing.
 * @param {object} request The server, token, body, extra headers, and HTTP method.
 * @param {string} request.base The server origin.
 * @param {unknown} request.body The JSON-RPC message; only sent with POST.
 * @param {Readonly<Record<string, string>>} request.headers Extra headers.
 * @param {"DELETE" | "POST"} request.method The HTTP method (default POST).
 * @param {string} request.token The MCP access token.
 * @returns {McpResult} The response.
 */
const legacyMcp = (request: {
  readonly base: string
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly method?: "DELETE" | "POST" | undefined
  readonly token: string
}): McpResult =>
  Effect.gen(function* callLegacy() {
    const headers = Struct.assign(
      { accept: ACCEPT, authorization: `Bearer ${request.token}`, "content-type": CONTENT_JSON },
      request.headers ?? {},
    )
    const url = `${request.base}${MCP_PATH}`
    if (request.method === "DELETE") {
      return yield* sendBodiless({ headers, method: "DELETE", url })
    }
    return yield* send({ body: yield* jsonBody(request.body), headers, method: "POST", url })
  })

const dataLine = (text: string): Option.Option<string> =>
  pipe(
    Str.split(text, "\n"),
    Arr.findFirst((line) => pipe(line, Str.startsWith(DATA_PREFIX))),
    Option.map(Str.slice(DATA_START)),
  )

const JsonText = Schema.fromJsonString(Schema.Unknown)

/**
 * The JSON-RPC message in a JSON or single-event SSE response.
 * @param {HttpClientResponse.HttpClientResponse} response The MCP response.
 * @returns {Effect.Effect<unknown, HttpClientError.HttpClientError | Schema.SchemaError>} The parsed message.
 */
const rpcMessage = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, HttpClientError.HttpClientError | Schema.SchemaError> =>
  Effect.gen(function* readMessage() {
    const text = yield* textOf(response)
    const data = pipe(text, Str.startsWith(JSON_START)) ? Option.some(text) : dataLine(text)
    return yield* Schema.decodeEffect(JsonText)(Option.getOrElse(data, () => NO_MESSAGE))
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { legacyMcp, mcp, rpcMessage }
