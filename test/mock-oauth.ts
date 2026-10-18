/**
 * OAuth routes for the mock Hardcover server: discovery, auto-approved
 * authorization, token exchange with PKCE, refresh rotation, and revocation.
 */
import type { AuthorizationCode, RecordedRequests, TokenStore } from "#test/mock-store.ts"
import { BAD_REQUEST, empty, json, parameterOrEmpty, present, redirect, text } from "#test/mock-http.ts"
import { Effect, Option, Predicate, Record as Rec } from "effect"
import { asJson, freshCode, grantSpent } from "#test/mock-store.ts"
import { digest } from "#test/mock-codec.ts"

const AUTHORIZE_PATH = "/oauth2/authorize"
const CHALLENGE_METHOD = "S256"
const EMPTY = ""
const GRANT_CODE = "authorization_code"
const GRANT_REFRESH = "refresh_token"
const REVOKE_PATH = "/oauth2/revoke"
const TOKEN_PATH = "/oauth2/token"

const discovery = (issuer: string): Response =>
  Response.json({
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    authorization_response_iss_parameter_supported: true,
    code_challenge_methods_supported: [CHALLENGE_METHOD],
    issuer,
    revocation_endpoint: `${issuer}${REVOKE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
  })

const queryValue = (url: URL, name: string): string => parameterOrEmpty({ name, url })

const acceptedAuthorize = (url: URL, clientId: string): boolean =>
  queryValue(url, "client_id") === clientId &&
  queryValue(url, "code_challenge_method") === CHALLENGE_METHOD &&
  present(queryValue(url, "code_challenge"))

const rememberedCode = (url: URL, store: TokenStore): string => {
  const code = freshCode()
  store.codes.set(code, {
    challenge: queryValue(url, "code_challenge"),
    redirectUri: queryValue(url, "redirect_uri"),
    scope: queryValue(url, "scope"),
  })
  return code
}

const approvedLocation = (url: URL, issuer: string, code: string): URL => {
  const back = new URL(queryValue(url, "redirect_uri"))
  back.searchParams.set("code", code)
  back.searchParams.set("state", queryValue(url, "state"))
  back.searchParams.set("iss", issuer)
  return back
}

const authorize = (options: Readonly<{ clientId: string; issuer: string; store: TokenStore; url: URL }>): Response => {
  if (!acceptedAuthorize(options.url, options.clientId)) {
    return text({ body: "bad authorize request", status: BAD_REQUEST })
  }
  return redirect(approvedLocation(options.url, options.issuer, rememberedCode(options.url, options.store)))
}

const expectedBasic = (clientId: string, clientSecret: string): string =>
  `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`

const codeMatches = (entry: AuthorizationCode, form: Readonly<Record<string, string>>, challenge: string): boolean =>
  entry.redirectUri === (form.redirect_uri ?? EMPTY) && entry.challenge === challenge

const exchangeCode = (form: Readonly<Record<string, string>>, store: TokenStore): Effect.Effect<Response> =>
  Effect.gen(function* verifyCode() {
    const entry = store.codes.get(form.code ?? EMPTY)
    store.codes.delete(form.code ?? EMPTY)
    const challenge = yield* digest(form.code_verifier ?? EMPTY)
    if (Predicate.isUndefined(entry) || !codeMatches(entry, form, challenge)) {
      return json({ body: { error: "invalid_grant", error_description: "bad code, redirect_uri, or verifier" }, status: BAD_REQUEST })
    }
    return Response.json(asJson(store.issue(entry.scope)))
  })

const exchangeRefresh = (form: Readonly<Record<string, string>>, store: TokenStore): Response => {
  const entry = Option.fromNullishOr(store.refreshTokens.get(form.refresh_token ?? EMPTY))
  if (grantSpent(entry)) {
    return json({ body: { error: "invalid_grant", error_description: "refresh token reused or unknown" }, status: BAD_REQUEST })
  }
  const scope = Option.match(entry, { onNone: () => EMPTY, onSome: (grant) => grant.scope })
  const current = { scope, spent: true }
  store.refreshTokens.set(form.refresh_token ?? EMPTY, current)
  return Response.json(asJson(store.issue(current.scope)))
}

const granted = (form: Readonly<Record<string, string>>, store: TokenStore): Effect.Effect<Response> => {
  if (form.grant_type === GRANT_CODE) {
    return exchangeCode(form, store)
  }
  if (form.grant_type === GRANT_REFRESH) {
    return Effect.succeed(exchangeRefresh(form, store))
  }
  return Effect.succeed(json({ body: { error: "unsupported_grant_type" }, status: BAD_REQUEST }))
}

const recorded = (form: Readonly<Record<string, string>>): Record<string, string> => {
  const copy: Record<string, string> = {}
  for (const [key, value] of Rec.toEntries(form)) {
    copy[key] = value
  }
  return copy
}

const authenticated = (options: Readonly<{ clientId: string; clientSecret: string; header: string | null }>): boolean =>
  options.header === expectedBasic(options.clientId, options.clientSecret)

const token = (exchange: {
  readonly form: Readonly<Record<string, string>>
  readonly path: string
  readonly requests: RecordedRequests
  readonly store: TokenStore
}): Effect.Effect<Response> =>
  Effect.gen(function* exchangeToken() {
    exchange.requests.append(recorded(exchange.form))
    if (exchange.path === REVOKE_PATH) {
      return empty()
    }
    return yield* granted(exchange.form, exchange.store)
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { AUTHORIZE_PATH, REVOKE_PATH, TOKEN_PATH, authenticated, authorize, discovery, token }
