/**
 * A scripted MCP client for end-to-end runs: registers with DCR, walks the
 * browser part of authorization (consent page, Hardcover, callback) with a
 * cookie jar, and exchanges the code for MCP tokens.
 */
import type { AuthorizeOptions, Authorized, Denied } from "#test/client-authorize.ts"
import { CONTENT_FORM, ClientError, RESOURCE_PATH } from "#test/client-walk.ts"
import type { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { formBody, post } from "#test/client-http.ts"
import { Effect } from "effect"
import type { Schema } from "effect"
import type { WalkError } from "#test/client-walk.ts"
import { authorize } from "#test/client-authorize.ts"

type Authorization<Result> = Effect.Effect<Result, WalkError | Schema.SchemaError, HttpClient.HttpClient>

const isDenied = (result: Authorized | Denied): result is Denied => "denied" in result

const isAuthorized = (result: Authorized | Denied): result is Authorized => !isDenied(result)

/**
 * Authorization that must end with tokens.
 * @param {AuthorizeOptions} options The server and authorization choices.
 * @returns {Authorization<Authorized>} The tokens; a denial fails.
 */
const approved = (options: AuthorizeOptions): Authorization<Authorized> =>
  authorize(options).pipe(Effect.filterOrFail(isAuthorized, () => ClientError.make({ message: "denied" })))

/**
 * Authorization that must end with a denial.
 * @param {AuthorizeOptions} options The server and authorization choices.
 * @returns {Authorization<Denied>} The denial redirect; tokens fail.
 */
const denied = (options: AuthorizeOptions): Authorization<Denied> =>
  authorize(options).pipe(Effect.filterOrFail(isDenied, () => ClientError.make({ message: "expected a denial" })))

/**
 * Exchanges an MCP refresh token.
 * @param {object} options The server, client, and refresh token.
 * @param {string} options.base The server origin.
 * @param {string} options.clientId The registered client.
 * @param {string} options.refreshToken The refresh token to spend.
 * @returns {Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient>} The token response.
 */
const refresh = (options: {
  readonly base: string
  readonly clientId: string
  readonly refreshToken: string
}): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError, HttpClient.HttpClient> =>
  post({
    body: formBody(
      new URLSearchParams({
        client_id: options.clientId,
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
        resource: `${options.base}${RESOURCE_PATH}`,
      }),
    ),
    headers: { "content-type": CONTENT_FORM },
    url: `${options.base}/token`,
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { approved, denied, refresh }
