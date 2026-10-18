/**
 * The browser half of authorization: registration, the consent page, and
 * following one redirect. Each step fails with the same message the old
 * client threw.
 */
import { Array as Arr, Effect, Option, Predicate, Schema, String as Str, pipe } from "effect"
import type { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { absorb, emptyJar } from "#test/client-cookies.ts"
import { decodeJson, get, jsonBody, post, succeeded, textOf } from "#test/client-http.ts"
import type { Jar } from "#test/client-cookies.ts"

const CALLBACK = "http://localhost:9876/callback"
const CLIENT_NAME = "E2E Client"
const CONSENT_STATUS = 200
const CONTENT_FORM = "application/x-www-form-urlencoded"
const CONTENT_JSON = "application/json"
const HANDLE_PATTERN = /name="handle" value="(?<handle>[^"]+)"/v
const PREVIEW = 300
const REDIRECT = 302
const RESOURCE_PATH = "/mcp"
const SCOPE_PATTERN = /<input type="checkbox" name="scope" value="(?<scope>[^"]+)" checked/gv
const SLICE_START = 0

const Registration = Schema.Struct({ client_id: Schema.String })

class ClientError extends Schema.TaggedError<ClientError, { readonly brand: unique symbol }>()("ClientError", {
  message: Schema.String,
}) {}

type WalkError = ClientError | HttpClientError.HttpClientError

const failed = (message: string): Effect.Effect<never, ClientError> => Effect.fail(ClientError.make({ message }))

const asClientError = (error: Readonly<{ message: string }>): ClientError => ClientError.make({ message: error.message })

const failedWithBody = (options: {
  readonly label: string
  readonly response: HttpClientResponse.HttpClientResponse
}): Effect.Effect<never, WalkError> =>
  textOf(options.response).pipe(Effect.flatMap((body) => failed(`${options.label}: ${options.response.status} ${body}`)))

const register = (base: string): Effect.Effect<string, WalkError | Schema.SchemaError, HttpClient.HttpClient> =>
  Effect.gen(function* registerClient() {
    const body = yield* jsonBody({ client_name: CLIENT_NAME, redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" }).pipe(
      Effect.mapError(asClientError),
    )
    const response = yield* post({ body, headers: { "content-type": CONTENT_JSON }, url: `${base}/register` })
    if (!succeeded(response)) {
      return yield* failedWithBody({ label: "register", response })
    }
    const registration = yield* decodeJson({ response, schema: Registration })
    return registration.client_id
  })

interface Consent {
  readonly handle: string
  readonly html: string
  readonly jar: Jar
  readonly prechecked: ReadonlyArray<string>
}

const handleOf = (html: string): Option.Option<string> => Option.fromNullishOr(HANDLE_PATTERN.exec(html)?.groups?.handle)

const precheckedOf = (html: string): ReadonlyArray<string> =>
  pipe(
    [...html.matchAll(SCOPE_PATTERN)],
    Arr.map((match) => match.groups?.scope),
    Arr.filter(Predicate.isNotUndefined),
  )

const consentPage = (url: URL): Effect.Effect<Consent, WalkError, HttpClient.HttpClient> =>
  Effect.gen(function* readConsent() {
    const response = yield* get({ url })
    const jar = absorb({ jar: emptyJar, response })
    const html = yield* textOf(response)
    if (response.status !== CONSENT_STATUS) {
      return yield* failed(`consent page: ${response.status} ${pipe(html, Str.slice(SLICE_START, PREVIEW))}`)
    }
    const handle = handleOf(html)
    if (Option.isNone(handle)) {
      return yield* failed("no consent handle")
    }
    return { handle: handle.value, html, jar, prechecked: precheckedOf(html) }
  })

/**
 * Reads the `Location` of a 302, or fails with the response body.
 * @param {object} options The redirect response and a label for failures.
 * @param {string} options.label The step name used in failure messages.
 * @param {HttpClientResponse.HttpClientResponse} options.response The response that should redirect.
 * @returns {Effect.Effect<URL, WalkError>} Where the redirect points.
 */
const redirectedTo = (options: {
  readonly label: string
  readonly response: HttpClientResponse.HttpClientResponse
}): Effect.Effect<URL, WalkError> => {
  const location = Option.fromNullishOr(options.response.headers.location)
  if (options.response.status !== REDIRECT || Option.isNone(location)) {
    return failedWithBody(options)
  }
  return Effect.succeed(new URL(location.value))
}

/**
 * Application module, not a public API.
 * @internal
 */
export { CALLBACK, CONTENT_FORM, ClientError, RESOURCE_PATH, consentPage, failed, failedWithBody, redirectedTo, register }

/**
 * Application module, not a public API.
 * @internal
 */
export type { Consent, WalkError }
