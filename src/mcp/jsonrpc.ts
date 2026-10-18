/** Small HTTP and JSON-RPC helpers for the `/mcp` wrapper in front of Effect's server. */
import { Option } from "effect"

const JSON_RPC_VERSION = "2.0"
const OK_STATUS = 200
const UNAUTHORIZED_STATUS = 401
const JSON_CONTENT_TYPE = "application/json"

interface RpcErrorBody {
  readonly error: { readonly code: number; readonly message: string }
  readonly id: string | number | null
  readonly jsonrpc: string
}

/**
 * A JSON-RPC error object. A missing id is sent as `null`, as the spec requires.
 * @param {object} options The error.
 * @param {string | number | null} options.id The request id, when the request had one.
 * @param {number} options.code The JSON-RPC error code.
 * @param {string} options.message The error message.
 * @returns {RpcErrorBody} The error object.
 */
const rpcError = (options: { readonly id?: string | number | null; readonly code: number; readonly message: string }): RpcErrorBody => ({
  error: { code: options.code, message: options.message },
  id: Option.getOrNull(Option.fromNullishOr(options.id)),
  jsonrpc: JSON_RPC_VERSION,
})

/**
 * A JSON response. Extra headers are copied, then `content-type` is set.
 * @param {object} options The response.
 * @param {unknown} options.body The JSON value.
 * @param {number} options.status The HTTP status, 200 when omitted.
 * @param {Readonly<Record<string, string>>} options.headers Extra response headers.
 * @returns {Response} The response.
 */
const json = (options: {
  readonly body: unknown
  readonly status?: number
  readonly headers?: Readonly<Record<string, string>>
}): Response => {
  const out = new Headers(options.headers)
  out.set("content-type", JSON_CONTENT_TYPE)
  return Response.json(options.body, { headers: out, status: options.status ?? OK_STATUS })
}

/**
 * `401` that sends the client back through authorization, pointing at this resource's metadata.
 * @param {object} options The refusal.
 * @param {Request} options.request The request being refused.
 * @param {string} options.description Why the token is no longer accepted.
 * @returns {Response} The challenge.
 */
const reauthorize = (options: { readonly request: Request; readonly description: string }): Response => {
  const url = new URL(options.request.url)
  const metadata = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`
  const quoted = options.description.replaceAll('"', "'")
  return json({
    body: { error: "invalid_token", error_description: options.description },
    headers: { "www-authenticate": `Bearer error="invalid_token", error_description="${quoted}", resource_metadata="${metadata}"` },
    status: UNAUTHORIZED_STATUS,
  })
}

/**
 * Application module, not a public API.
 * @internal
 */
export { json, reauthorize, rpcError }
