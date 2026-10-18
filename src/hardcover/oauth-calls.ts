/**
 * Hardcover as an OAuth authorization server: the authorization URL, the code
 * exchange, refresh, and revocation, for a confidential ("Web app (server-side)")
 * client. Hardcover requires PKCE (S256) from every client and rotates refresh
 * tokens on each use; replaying a spent refresh token revokes the whole chain.
 * https://docs.hardcover.app/api/oauth/
 */
import { Array as Arr, Crypto, Effect, Option, pipe } from "effect"
import type { HardcoverOAuthError, TokenSet } from "#src/hardcover/oauth-types.ts"
import { discover, postForm, revocationEndpoint, toTokenSet } from "#src/hardcover/oauth-http.ts"
import { Base64Url } from "effect/encoding"
import type { HardcoverEndpoints } from "#src/env.ts"
import type { HttpClient } from "effect/http"

const VERIFIER_BYTES = 32

interface PkcePair {
  readonly verifier: string
  readonly challenge: string
}

/**
 * The URL that sends the browser to Hardcover.
 * @param {object} options The configured client and the approved request.
 * @param {HardcoverEndpoints} options.endpoints The configured client.
 * @param {string} options.redirectUri Our callback URL.
 * @param {ReadonlyArray<string>} options.scope The scopes to ask Hardcover for.
 * @param {string} options.state The state that ties the callback to this request.
 * @param {string} options.codeChallenge The PKCE challenge.
 * @returns {Effect.Effect<string, HardcoverOAuthError, HttpClient.HttpClient>} The authorization URL.
 */
const authorizationUrl = (options: {
  readonly endpoints: HardcoverEndpoints
  readonly redirectUri: string
  readonly scope: ReadonlyArray<string>
  readonly state: string
  readonly codeChallenge: string
}): Effect.Effect<string, HardcoverOAuthError, HttpClient.HttpClient> =>
  Effect.map(discover(options.endpoints.issuer), (metadata) => {
    const url = new URL(metadata.authorization_endpoint)
    url.search = new URLSearchParams([
      ["response_type", "code"],
      ["client_id", options.endpoints.clientId],
      ["redirect_uri", options.redirectUri],
      ["scope", pipe(options.scope, Arr.join(" "))],
      ["state", options.state],
      ["code_challenge", options.codeChallenge],
      ["code_challenge_method", "S256"],
    ]).toString()
    return url.toString()
  })

/**
 * Posts a grant to Hardcover's token endpoint.
 * @param {HardcoverEndpoints} endpoints The configured client.
 * @param {ReadonlyArray<readonly [string, string]>} form The grant, in order.
 * @returns {Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient>} The tokens.
 */
const requestTokens = (
  endpoints: HardcoverEndpoints,
  form: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient> =>
  discover(endpoints.issuer).pipe(
    Effect.flatMap((metadata) => postForm({ endpoints, form, url: metadata.token_endpoint })),
    Effect.flatMap(toTokenSet),
  )

/**
 * Exchanges Hardcover's authorization code for tokens.
 * @param {object} options The configured client and the code.
 * @param {HardcoverEndpoints} options.endpoints The configured client.
 * @param {string} options.code The authorization code.
 * @param {string} options.redirectUri The callback URL the code was issued to.
 * @param {string} options.codeVerifier The PKCE verifier.
 * @returns {Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient>} The tokens.
 */
const exchangeCode = (options: {
  readonly endpoints: HardcoverEndpoints
  readonly code: string
  readonly redirectUri: string
  readonly codeVerifier: string
}): Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient> =>
  requestTokens(options.endpoints, [
    ["grant_type", "authorization_code"],
    ["code", options.code],
    ["redirect_uri", options.redirectUri],
    ["code_verifier", options.codeVerifier],
  ])

/**
 * Spends `refreshToken`. The caller must persist the returned set before using it.
 * @param {object} options The configured client and the refresh token.
 * @param {HardcoverEndpoints} options.endpoints The configured client.
 * @param {string} options.refreshToken The refresh token to spend.
 * @returns {Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient>} The rotated tokens.
 */
const refreshTokens = (options: {
  readonly endpoints: HardcoverEndpoints
  readonly refreshToken: string
}): Effect.Effect<TokenSet, HardcoverOAuthError, HttpClient.HttpClient> =>
  requestTokens(options.endpoints, [
    ["grant_type", "refresh_token"],
    ["refresh_token", options.refreshToken],
  ])

/**
 * Revokes the token and, on Hardcover, every token issued with it. Callers treat it as best effort.
 * @param {object} options The configured client and the token.
 * @param {HardcoverEndpoints} options.endpoints The configured client.
 * @param {string} options.token The refresh token.
 * @returns {Effect.Effect<void, HardcoverOAuthError, HttpClient.HttpClient>} Done once Hardcover answered, or at once when it names no revocation endpoint.
 */
const revokeToken = (options: {
  readonly endpoints: HardcoverEndpoints
  readonly token: string
}): Effect.Effect<void, HardcoverOAuthError, HttpClient.HttpClient> =>
  Effect.flatMap(discover(options.endpoints.issuer), (metadata) =>
    Option.match(revocationEndpoint(metadata), {
      onNone: () => Effect.void,
      onSome: (url) =>
        Effect.asVoid(
          postForm({
            endpoints: options.endpoints,
            form: [
              ["token", options.token],
              ["token_type_hint", "refresh_token"],
            ],
            url,
          }),
        ),
    }),
  )

/** A PKCE verifier (43 chars of base64url entropy) and its S256 challenge. */
const pkce: Effect.Effect<PkcePair, never, Crypto.Crypto> = Effect.gen(function* makePkce() {
  const random = yield* Crypto.Crypto
  const verifier = Base64Url.encode(yield* Effect.orDie(random.randomBytes(VERIFIER_BYTES)))
  const digest = yield* Effect.orDie(random.digest("SHA-256", new TextEncoder().encode(verifier)))
  return { challenge: Base64Url.encode(digest), verifier }
})

/**
 * Application module, not a public API.
 * @internal
 */
export { authorizationUrl, exchangeCode, pkce, refreshTokens, revokeToken }
