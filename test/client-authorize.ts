/**
 * Runs the scripted authorization: registers with DCR, ticks scopes on the
 * consent page, follows Hardcover (the mock) back to the callback, and
 * exchanges the code for MCP tokens. A denial ends at the client's redirect
 * URI and comes back as `{ denied }` instead of tokens.
 */
import { CALLBACK, CONTENT_FORM, RESOURCE_PATH, consentPage, failed, failedWithBody, redirectedTo, register } from "#test/client-walk.ts"
import type { Consent, WalkError } from "#test/client-walk.ts"
import { Effect, Option, Schema, String as Str, Struct, pipe } from "effect"
import { absorb, cookieHeader } from "#test/client-cookies.ts"
import { decodeJson, formBody, get, post, succeeded } from "#test/client-http.ts"
import { digest, randomEncoded } from "#test/mock-codec.ts"
import type { HttpClient } from "effect/http"
import type { Jar } from "#test/client-cookies.ts"

const APPROVE = "approve"
const CHALLENGE_METHOD = "S256"
const GRANT = "authorization_code"
const RESPONSE_TYPE = "code"
const STATE = "xyz"
const VERIFIER_BYTES = 32

const Tokens = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optionalKey(Schema.Finite),
  refresh_token: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
})

interface IssuedTokens {
  readonly access_token: string
  readonly expires_in?: number
  readonly refresh_token: string
  readonly scope: string
}

interface Authorized {
  readonly clientId: string
  readonly consentHtml: string
  readonly tokens: IssuedTokens
}

interface Denied {
  readonly consentHtml: string
  readonly denied: URL
}

/** `pick` chooses the scopes to tick on the consent page (default: as pre-ticked). */
interface AuthorizeOptions {
  readonly base: string
  readonly decision?: "approve" | "deny" | undefined
  readonly pick?: ((prechecked: ReadonlyArray<string>) => ReadonlyArray<string>) | undefined
  readonly scope?: string | undefined
}

interface Started {
  readonly clientId: string
  readonly consent: Consent
  readonly options: AuthorizeOptions
  readonly verifier: string
}

const authorizeUrl = (options: Readonly<{ base: string; challenge: string; clientId: string; scope: Option.Option<string> }>): URL => {
  const url = new URL(`${options.base}/authorize`)
  const fields = new URLSearchParams({
    client_id: options.clientId,
    code_challenge: options.challenge,
    code_challenge_method: CHALLENGE_METHOD,
    redirect_uri: CALLBACK,
    resource: `${options.base}${RESOURCE_PATH}`,
    response_type: RESPONSE_TYPE,
    state: STATE,
  })
  if (Option.isSome(options.scope)) {
    fields.set("scope", options.scope.value)
  }
  url.search = fields.toString()
  return url
}

const consentForm = (started: Started): URLSearchParams => {
  const form = new URLSearchParams({ decision: started.options.decision ?? APPROVE, handle: started.consent.handle })
  const { pick } = started.options
  const scopes = Option.match(Option.fromNullishOr(pick), {
    onNone: () => started.consent.prechecked,
    onSome: (choose) => choose(started.consent.prechecked),
  })
  for (const scope of scopes) {
    form.append("scope", scope)
  }
  return form
}

const tokenForm = (started: Started, code: string): URLSearchParams =>
  new URLSearchParams({
    client_id: started.clientId,
    code,
    code_verifier: started.verifier,
    grant_type: GRANT,
    redirect_uri: CALLBACK,
    resource: `${started.options.base}${RESOURCE_PATH}`,
  })

const exchanged = (started: Started, code: string): Effect.Effect<IssuedTokens, WalkError | Schema.SchemaError, HttpClient.HttpClient> =>
  Effect.gen(function* exchangeCode() {
    const response = yield* post({
      body: formBody(tokenForm(started, code)),
      headers: { "content-type": CONTENT_FORM },
      url: `${started.options.base}/token`,
    })
    if (!succeeded(response)) {
      return yield* failedWithBody({ label: "token", response })
    }
    const tokens = yield* decodeJson({ response, schema: Tokens })
    return Struct.assign(tokens, { refresh_token: tokens.refresh_token ?? "", scope: tokens.scope ?? "" })
  })

const callbackCode = (jar: Jar, upstreamUrl: URL): Effect.Effect<string, WalkError, HttpClient.HttpClient> =>
  Effect.gen(function* followHardcover() {
    // Hardcover (the mock) approves and redirects to our /callback.
    const upstream = yield* get({ url: upstreamUrl })
    const callbackUrl = yield* redirectedTo({ label: "upstream authorize", response: upstream })
    const callback = yield* get({ headers: { cookie: cookieHeader(jar) }, url: callbackUrl })
    const done = yield* redirectedTo({ label: "callback", response: callback })
    const code = Option.fromNullishOr(done.searchParams.get("code"))
    if (Option.isNone(code)) {
      return yield* failed(`no code: ${done.toString()}`)
    }
    return code.value
  })

const completed = (started: Started): Effect.Effect<Authorized | Denied, WalkError | Schema.SchemaError, HttpClient.HttpClient> =>
  Effect.gen(function* submitConsent() {
    const submitted = yield* post({
      body: formBody(consentForm(started)),
      headers: { "content-type": CONTENT_FORM, cookie: cookieHeader(started.consent.jar) },
      url: `${started.options.base}/authorize`,
    })
    const jar = absorb({ jar: started.consent.jar, response: submitted })
    const next = yield* redirectedTo({ label: "consent submit", response: submitted })
    if (pipe(next.toString(), Str.startsWith(CALLBACK))) {
      return { consentHtml: started.consent.html, denied: next }
    }
    const tokens = yield* exchanged(started, yield* callbackCode(jar, next))
    return { clientId: started.clientId, consentHtml: started.consent.html, tokens }
  })

/**
 * Runs authorization end to end.
 * @param {AuthorizeOptions} options The server, and optionally the scope to request, the scopes to tick, and the decision.
 * @returns {Effect.Effect<Authorized | Denied, WalkError | Schema.SchemaError, HttpClient.HttpClient>} Tokens, or the denial redirect.
 */
const authorize = (options: AuthorizeOptions): Effect.Effect<Authorized | Denied, WalkError | Schema.SchemaError, HttpClient.HttpClient> =>
  Effect.gen(function* authorizeClient() {
    const clientId = yield* register(options.base)
    const verifier = randomEncoded(VERIFIER_BYTES)
    const challenge = yield* digest(verifier)
    const scope = pipe(Option.fromNullishOr(options.scope), Option.filter(Str.isNonEmpty))
    const url = authorizeUrl({ base: options.base, challenge, clientId, scope })
    const consent = yield* consentPage(url)
    return yield* completed({ clientId, consent, options, verifier })
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { authorize }
export type { AuthorizeOptions, Authorized, Denied }
