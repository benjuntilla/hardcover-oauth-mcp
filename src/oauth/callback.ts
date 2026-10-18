/**
 * `/callback`: exchanges Hardcover's code, records the tokens in a
 * `HardcoverConnection`, and completes the MCP client's authorization.
 */
import { Array as Arr, Crypto, Effect, Option, Result, String as Str, Struct, pipe } from "effect"
import type { AuthorizeRequest, UpstreamData } from "#src/oauth/consent.ts"
import type { Env, GrantProps, HardcoverEndpoints } from "#src/env.ts"
import { exchangeCode, revokeToken } from "#src/hardcover/oauth-calls.ts"
import { fetchAccount, isAllowedUser } from "#src/hardcover/graphql.ts"
import { html, messagePage, redirect } from "#src/oauth/pages.ts"
import { normalizeScopes, scopesForRoles } from "#src/hardcover/scopes.ts"
import type { AuthRequest } from "@cloudflare/workers-oauth-provider"
import type { HttpClient } from "effect/http"
import { authorizationErrorRedirect } from "@cloudflare/workers-oauth-provider"
import { grantUserId } from "#src/oauth/secrets.ts"
import { hardcoverEndpoints } from "#src/env.ts"

const BAD_REQUEST = 400
const FORBIDDEN = 403
const ROLES_SCOPE = "read:me:roles"

/** The authorization request `finishUpstream` recovered, and the headers to send with the answer. */
interface Upstream {
  readonly request: AuthRequest
  readonly headers: Headers
}

/** The signed-in account, as `fetchAccount` returns it. */
type Account = Effect.Success<ReturnType<typeof fetchAccount>>

/** Hardcover's tokens, as `exchangeCode` returns them. */
type TokenSet = Effect.Success<ReturnType<typeof exchangeCode>>

/** Why Hardcover refused the code exchange. */
type HardcoverOAuthError = Effect.Error<ReturnType<typeof exchangeCode>>

/**
 * A sign-in failure page.
 * @param {string} message What went wrong.
 * @param {Headers} headers The headers to send with it.
 * @returns {Response} The page.
 */
const signInFailed = (message: string, headers: Headers): Response =>
  html({ body: messagePage({ message, title: "Sign-in failed" }), headers, status: BAD_REQUEST })

/**
 * The error to send the MCP client for Hardcover's. Only a refusal or an outage means the same to the client; the
 * rest (`invalid_scope`, `invalid_request`, …) are about this server's request to Hardcover, so they are its fault.
 * @param {string} error Hardcover's error code.
 * @returns {"access_denied" | "server_error" | "temporarily_unavailable"} The client's error code.
 */
const clientErrorCode = (error: string): "access_denied" | "server_error" | "temporarily_unavailable" =>
  error === "access_denied" || error === "temporarily_unavailable" ? error : "server_error"

/**
 * Hardcover's authorization code, or the answer that ends the sign-in.
 * @param {URL} url The callback URL.
 * @param {Upstream} upstream The recovered request.
 * @param {string} issuer Hardcover's issuer.
 * @returns {Result.Result<string, Response>} The code, or the response.
 */
const codeOf = (url: URL, upstream: Upstream, issuer: string): Result.Result<string, Response> => {
  const params = url.searchParams
  const error = Option.fromNullishOr(params.get("error"))
  if (Option.isSome(error)) {
    const description = Option.getOrUndefined(Option.fromNullishOr(params.get("error_description")))
    const location = authorizationErrorRedirect(upstream.request, clientErrorCode(error.value), description)
    return Result.fail(redirect({ headers: upstream.headers, location }))
  }
  // RFC 9207: Hardcover names itself in every callback; a different issuer means a mix-up attack.
  if (params.get("iss") !== issuer) {
    return Result.fail(signInFailed("The response did not come from Hardcover. Start connecting again.", upstream.headers))
  }
  const code = pipe(Option.fromNullishOr(params.get("code")), Option.filter(Str.isNonEmpty))
  return Result.fromOption(code, () => signInFailed("Hardcover did not return an authorization code.", upstream.headers))
}

/**
 * The scopes Hardcover granted out of those requested; all of them when it didn't say.
 * @param {ReadonlyArray<string>} requested The scopes the client was approved for.
 * @param {Option.Option<ReadonlyArray<string>>} granted The scopes Hardcover named.
 * @returns {Array<string>} The granted scopes.
 */
const grantedScopes = (requested: ReadonlyArray<string>, granted: Option.Option<ReadonlyArray<string>>): Array<string> =>
  normalizeScopes(
    Option.match(granted, {
      onNone: () => requested,
      onSome: (named) =>
        pipe(
          requested,
          Arr.filter((scope) => pipe(named, Arr.contains(scope))),
        ),
    }),
  )

/**
 * Refuses an account the allowlist doesn't name, after revoking its tokens (best effort).
 * @param {object} options The refused sign-in.
 * @param {Account} options.account The account.
 * @param {HardcoverEndpoints} options.endpoints Hardcover's endpoints.
 * @param {TokenSet} options.tokens The tokens to revoke.
 * @param {Headers} options.headers The headers to send with the page.
 * @returns {Effect.Effect<Response, never, HttpClient.HttpClient>} The page.
 */
const refuseAccount = (options: {
  readonly account: Account
  readonly endpoints: HardcoverEndpoints
  readonly tokens: TokenSet
  readonly headers: Headers
}): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.as(
    Effect.ignoreCause(revokeToken({ endpoints: options.endpoints, token: options.tokens.refreshToken })),
    html({
      body: messagePage({
        detail: "If this is your server, add the username or id to allowedUsers in alchemy.run.ts and deploy again.",
        message: `Hardcover user @${options.account.username} (id ${options.account.id}) is not allowed to use this MCP server.`,
        title: "This server is private",
      }),
      headers: options.headers,
      status: FORBIDDEN,
    }),
  )

/**
 * Stores the tokens in a new connection and completes the MCP client's authorization.
 * @param {object} options The accepted sign-in.
 * @param {Account} options.account The account.
 * @param {Env} options.env The Worker bindings.
 * @param {ReadonlyArray<string>} options.granted The scopes Hardcover granted.
 * @param {TokenSet} options.tokens The tokens.
 * @param {Upstream} options.upstream The recovered request.
 * @returns {Effect.Effect<Response, never, Crypto.Crypto>} The redirect back to the client.
 */
const connect = (options: {
  readonly account: Account
  readonly env: Env
  readonly granted: ReadonlyArray<string>
  readonly tokens: TokenSet
  readonly upstream: Upstream
}): Effect.Effect<Response, never, Crypto.Crypto> =>
  Effect.gen(function* storeConnection() {
    const { account, env, upstream } = options
    const random = yield* Crypto.Crypto
    const connectionId = yield* Effect.orDie(random.randomUUIDv4())
    const tokens = Struct.pick(options.tokens, ["accessToken", "accessTokenExpiresAt", "refreshToken"])
    yield* Effect.promise(() =>
      env.HARDCOVER_CONNECTION.getByName(connectionId).init({ hcUserId: account.id, tokens, username: account.username }),
    )
    const props: GrantProps = {
      connectionId,
      hcUserId: account.id,
      librarianRoles: account.librarianRoles,
      supporter: account.supporter,
      username: account.username,
    }
    const userId = yield* Effect.promise(() => grantUserId({ clientSecret: env.HARDCOVER_CLIENT_SECRET, hcUserId: account.id }))
    const { redirectTo } = yield* Effect.promise(() =>
      env.OAUTH_PROVIDER.completeAuthorization({
        metadata: { connectionId, username: account.username },
        props,
        request: upstream.request,
        scope: scopesForRoles(options.granted, account.librarianRoles),
        userId,
      }),
    )
    return redirect({ headers: upstream.headers, location: redirectTo })
  })

/**
 * Exchanges the code, checks the account against the allowlist, and connects it.
 * @param {object} options The callback.
 * @param {string} options.code Hardcover's authorization code.
 * @param {string} options.codeVerifier The PKCE verifier kept by `beginUpstream`.
 * @param {Env} options.env The Worker bindings.
 * @param {string} options.origin This server's public origin.
 * @param {Upstream} options.upstream The recovered request.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The response.
 */
const signIn = (options: {
  readonly code: string
  readonly codeVerifier: string
  readonly env: Env
  readonly origin: string
  readonly upstream: Upstream
}): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* exchangeAndConnect() {
    const { env, upstream } = options
    const endpoints = hardcoverEndpoints(env)
    const redirectUri = `${options.origin}/callback`
    const tokens = yield* exchangeCode({ code: options.code, codeVerifier: options.codeVerifier, endpoints, redirectUri })
    const granted = grantedScopes(upstream.request.scope, tokens.scope)
    const withRoles = pipe(granted, Arr.contains(ROLES_SCOPE))
    const account = yield* fetchAccount({ accessToken: tokens.accessToken, endpoints, withRoles })
    if (!isAllowedUser(env.ALLOWED_HARDCOVER_USERS, account)) {
      return yield* refuseAccount({ account, endpoints, headers: upstream.headers, tokens })
    }
    return yield* connect({ account, env, granted, tokens, upstream })
  })

/**
 * `GET /callback`.
 * @param {AuthorizeRequest} options The request.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The response. Not finding the signed-in account is a defect.
 */
const callback = (options: AuthorizeRequest): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* finishSignIn() {
    const { env, origin, req } = options
    const { data, headers, request } = yield* Effect.promise(() => env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(req))
    const upstream = { headers, request }
    const code = codeOf(new URL(req.url), upstream, hardcoverEndpoints(env).issuer)
    if (Result.isFailure(code)) {
      return code.failure
    }
    return yield* signIn({ code: code.success, codeVerifier: data.verifier, env, origin, upstream })
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { callback }
