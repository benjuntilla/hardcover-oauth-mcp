/**
 * `/authorize`: our consent page, then the browser's trip to Hardcover with the
 * approved scopes and a fresh PKCE pair.
 */
import { Array as Arr, Effect, Option, Struct } from "effect"
import { DEFAULT_SCOPES, UPSTREAM_SCOPES, normalizeScopes } from "#src/hardcover/scopes.ts"
import { authorizationUrl, pkce } from "#src/hardcover/oauth-calls.ts"
import { consentPage, html, redirect } from "#src/oauth/pages.ts"
import type { AuthRequest } from "@cloudflare/workers-oauth-provider"
import type { Crypto } from "effect"
import type { Env } from "#src/env.ts"
import type { HardcoverOAuthError } from "#src/hardcover/oauth-types.ts"
import type { HttpClient } from "effect/http"
import { consentCookieSecret } from "#src/oauth/secrets.ts"
import { hardcoverEndpoints } from "#src/env.ts"

/** What `beginUpstream` keeps for the callback. */
interface UpstreamData {
  readonly verifier: string
}

/** One `/authorize` request. */
interface AuthorizeRequest {
  readonly req: Request
  readonly env: Env
  /** This server's public origin. */
  readonly origin: string
}

/**
 * The scopes to pre-tick: what the client asked for, or the defaults when it asked for none.
 * @param {AuthRequest} request The parsed authorization request.
 * @returns {ReadonlyArray<string>} The scopes.
 */
const effectiveScopes = (request: AuthRequest): ReadonlyArray<string> =>
  normalizeScopes(Arr.isReadonlyArrayNonEmpty(request.scope) ? request.scope : DEFAULT_SCOPES)

/**
 * Sends the browser to Hardcover with the approved scopes and a fresh PKCE pair.
 * @param {object} options The approved request.
 * @param {Env} options.env The Worker bindings.
 * @param {string} options.origin This server's public origin.
 * @param {AuthRequest} options.request The approved request.
 * @param {Option.Option<Headers>} options.headers The consent response headers, when consent was just given.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The redirect to Hardcover.
 */
const toHardcover = (options: {
  readonly env: Env
  readonly origin: string
  readonly request: AuthRequest
  readonly headers: Option.Option<Headers>
}): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* beginHardcover() {
    const { env, origin, request } = options
    const { challenge, verifier } = yield* pkce
    const data: UpstreamData = { verifier }
    const upstreamOptions = Option.match(options.headers, { onNone: () => ({ data }), onSome: (headers) => ({ data, headers }) })
    const upstream = yield* Effect.promise(() => env.OAUTH_PROVIDER.beginUpstream(request, upstreamOptions))
    const location = yield* authorizationUrl({
      codeChallenge: challenge,
      endpoints: hardcoverEndpoints(env),
      redirectUri: `${origin}/callback`,
      scope: [...normalizeScopes(request.scope), ...UPSTREAM_SCOPES],
      state: upstream.state,
    })
    return redirect({ headers: upstream.headers, location })
  })

/**
 * `GET /authorize`: the consent page, or straight to Hardcover when consent is remembered.
 * @param {AuthorizeRequest} options The request.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The response.
 */
const showConsent = (options: AuthorizeRequest): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* consentOrSkip() {
    const { env, origin, req } = options
    const oauth = env.OAUTH_PROVIDER
    const parsed = yield* Effect.promise(() => oauth.parseAuthRequest(req))
    const request = Struct.evolve(parsed, { scope: () => [...effectiveScopes(parsed)] })
    const secret = yield* Effect.promise(() => consentCookieSecret(env.HARDCOVER_CLIENT_SECRET))
    if (yield* Effect.promise(() => oauth.isConsentRemembered(req, request, { secret }))) {
      return yield* toHardcover({ env, headers: Option.none(), origin, request })
    }
    const details = yield* Effect.promise(() => oauth.describeConsent(request))
    const consent = yield* Effect.promise(() => oauth.beginConsent(request))
    return html({ body: consentPage({ checked: new Set(request.scope), details, handle: consent.handle }), headers: consent.headers })
  })

/**
 * Approves the consent form and sends the browser to Hardcover with the scopes the user kept.
 * @param {AuthorizeRequest} options The request.
 * @param {string} handle The consent handle.
 * @param {URLSearchParams} form The submitted form.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The redirect to Hardcover.
 */
const approve = (
  options: AuthorizeRequest,
  handle: string,
  form: Readonly<URLSearchParams>,
): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* approveConsent() {
    const { env, origin, req } = options
    const scope = normalizeScopes(form.getAll("scope"))
    const secret = yield* Effect.promise(() => consentCookieSecret(env.HARDCOVER_CLIENT_SECRET))
    const approved = yield* Effect.promise(() => env.OAUTH_PROVIDER.approveConsent(req, handle, { remember: { secret }, scope }))
    const request = Struct.evolve(approved.request, { scope: () => scope })
    return yield* toHardcover({ env, headers: Option.some(approved.headers), origin, request })
  })

/**
 * `POST /authorize`: the consent form's answer. The form posts `application/x-www-form-urlencoded`.
 * @param {AuthorizeRequest} options The request.
 * @returns {Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient>} The redirect to Hardcover, or back to the client when denied.
 */
const submitConsent = (options: AuthorizeRequest): Effect.Effect<Response, HardcoverOAuthError, Crypto.Crypto | HttpClient.HttpClient> =>
  Effect.gen(function* answerConsent() {
    const { env, req } = options
    const form = new URLSearchParams(yield* Effect.promise(() => req.text()))
    const handle = Option.getOrElse(Option.fromNullishOr(form.get("handle")), () => "")
    if (form.get("decision") === "approve") {
      return yield* approve(options, handle, form)
    }
    const denied = yield* Effect.promise(() => env.OAUTH_PROVIDER.denyConsent(req, handle))
    return redirect({ headers: denied.headers, location: denied.redirectTo })
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { showConsent, submitConsent }
/**
 * Application module, not a public API.
 * @internal
 */
export type { AuthorizeRequest, UpstreamData }
