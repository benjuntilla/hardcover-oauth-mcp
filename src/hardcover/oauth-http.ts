/**
 * Hardcover's OAuth HTTP calls: RFC 8414 discovery, the form POST to its
 * endpoints, and the token response. Every request gives up after ten seconds.
 */
import { Array as Arr, Clock, Effect, Exit, Option, Predicate, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Base64 } from "effect/encoding"
import type { HardcoverEndpoints } from "#src/env.ts"
import { HardcoverOAuthError } from "#src/hardcover/oauth-types.ts"
import type { TokenSet } from "#src/hardcover/oauth-types.ts"
import { USER_AGENT } from "#src/env.ts"

const TIMEOUT = "10 seconds"
/** What `fetch` reports when its timeout signal fires. */
const TIMED_OUT = "The operation was aborted due to timeout"
const CACHE_TTL = "1 hour"
const NO_CACHE = 0
const HTTP_OK = 200
const HTTP_REDIRECT = 300
const HTTP_SERVER_ERROR = 500
const DISCOVERY_STATUS = 503
const NETWORK_STATUS = 503
const INVALID_RESPONSE_STATUS = 502
const NO_TTL = 0
const DEFAULT_TTL_SECONDS = 604_800
const MILLIS_PER_SECOND = 1000

/** The discovery document fields this server uses. */
const Metadata = Schema.Struct({
  authorization_endpoint: Schema.String,
  issuer: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.Unknown),
  token_endpoint: Schema.String,
})

type Discovered = typeof Metadata.Type

/** The fields of an OAuth error or token response, whatever else the body holds. */
const FormAnswer = Schema.Struct({
  access_token: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  error_description: Schema.optionalKey(Schema.Unknown),
  expires_in: Schema.optionalKey(Schema.Unknown),
  refresh_token: Schema.optionalKey(Schema.Unknown),
  scope: Schema.optionalKey(Schema.Unknown),
})

type FormFields = typeof FormAnswer.Type

/** One discovery run per issuer, shared while it runs and kept for an hour once it succeeds. */
const discoveries = new Map<string, Effect.Effect<Discovered, HardcoverOAuthError, HttpClient.HttpClient>>()

/**
 * Whether a status is a 2xx.
 * @param {number} status The HTTP status.
 * @returns {boolean} True for success.
 */
const isOk = (status: number): boolean => status >= HTTP_OK && status < HTTP_REDIRECT

/**
 * What `fetch` would have thrown for a request that failed or ran out of time.
 * @param {unknown} error The client's failure.
 * @returns {unknown} The underlying error.
 */
const thrown = (error: unknown): unknown => (Predicate.hasProperty(error, "cause") ? error.cause : error)

/**
 * Fetches and checks the discovery document. A network failure or a body that isn't JSON is a defect, as it always was.
 * @param {string} issuer The configured issuer.
 * @returns {Effect.Effect<Discovered, HardcoverOAuthError, HttpClient.HttpClient>} The metadata.
 */
const loadMetadata = (issuer: string): Effect.Effect<Discovered, HardcoverOAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* readMetadata() {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.get(`${issuer}/.well-known/oauth-authorization-server`).pipe(
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": USER_AGENT }),
    )
    const response = yield* client.execute(request).pipe(Effect.mapError(thrown), Effect.orDie)
    if (!isOk(response.status)) {
      return yield* HardcoverOAuthError.make({
        code: "temporarily_unavailable",
        description: `discovery returned HTTP ${response.status}`,
        status: DISCOVERY_STATUS,
      })
    }
    const body = yield* response.json.pipe(Effect.mapError(thrown), Effect.orDie)
    const mismatch = HardcoverOAuthError.make({
      code: "invalid_response",
      description: "discovery document does not match the configured issuer",
      status: INVALID_RESPONSE_STATUS,
    })
    return yield* Schema.decodeUnknownEffect(Metadata)(body).pipe(
      Effect.mapError(() => mismatch),
      Effect.filterOrFail(
        (metadata) => metadata.issuer === issuer && metadata.authorization_endpoint !== "" && metadata.token_endpoint !== "",
        () => mismatch,
      ),
    )
  }).pipe(Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.die(new DOMException(TIMED_OUT, "TimeoutError")) }))

/**
 * RFC 8414 discovery, cached per isolate for an hour. The issuer in the document must match.
 * @param {string} issuer The configured issuer.
 * @returns {Effect.Effect<Discovered, HardcoverOAuthError, HttpClient.HttpClient>} The discovered metadata.
 */
const discover = (issuer: string): Effect.Effect<Discovered, HardcoverOAuthError, HttpClient.HttpClient> =>
  Effect.suspend(() =>
    Option.match(Option.fromNullishOr(discoveries.get(issuer)), {
      onNone: () =>
        Effect.flatMap(
          Effect.cachedWithTTL(loadMetadata(issuer), (exit) => (Exit.isSuccess(exit) ? CACHE_TTL : NO_CACHE)),
          (cached) => {
            discoveries.set(issuer, cached)
            return cached
          },
        ),
      onSome: (cached) => cached,
    }),
  )

/**
 * The revocation endpoint, when Hardcover names one.
 * @param {Discovered} metadata The discovered metadata.
 * @returns {Option.Option<string>} The endpoint.
 */
const revocationEndpoint = (metadata: Discovered): Option.Option<string> =>
  Predicate.isString(metadata.revocation_endpoint) && metadata.revocation_endpoint !== ""
    ? Option.some(metadata.revocation_endpoint)
    : Option.none()

/**
 * The HTTP Basic credential for the confidential client.
 * @param {HardcoverEndpoints} endpoints The configured client.
 * @returns {string} The Authorization header value.
 */
const basicAuth = (endpoints: HardcoverEndpoints): string =>
  `Basic ${Base64.encode(`${encodeURIComponent(endpoints.clientId)}:${encodeURIComponent(endpoints.clientSecret)}`)}`

/**
 * The fields of a response body, or none of them when it isn't an object.
 * @param {unknown} body The parsed body.
 * @returns {FormFields} The fields.
 */
const answerFields = (body: unknown): FormFields =>
  pipe(
    Schema.decodeUnknownOption(FormAnswer)(body),
    Option.getOrElse((): FormFields => ({})),
  )

/**
 * Posts a form to one of Hardcover's OAuth endpoints and returns the fields of its JSON body.
 * @param {object} input The endpoint and the form.
 * @param {HardcoverEndpoints} input.endpoints The configured client.
 * @param {string} input.url The endpoint.
 * @param {ReadonlyArray<readonly [string, string]>} input.form The form fields, in order.
 * @returns {Effect.Effect<FormFields, HardcoverOAuthError, HttpClient.HttpClient>} The body's fields.
 */
const postForm = (input: {
  readonly endpoints: HardcoverEndpoints
  readonly url: string
  readonly form: ReadonlyArray<readonly [string, string]>
}): Effect.Effect<FormFields, HardcoverOAuthError, HttpClient.HttpClient> =>
  Effect.gen(function* postOAuthForm() {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        authorization: basicAuth(input.endpoints),
        "user-agent": USER_AGENT,
      }),
      HttpClientRequest.bodyUrlParams(input.form),
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError((error) => {
        const cause = thrown(error)
        return HardcoverOAuthError.make({
          code: "temporarily_unavailable",
          description: cause instanceof Error ? cause.message : "network error",
          status: NETWORK_STATUS,
        })
      }),
    )
    const fields = answerFields(yield* response.json.pipe(Effect.orElseSucceed(() => ({}))))
    if (isOk(response.status)) {
      return fields
    }
    const fallback = response.status >= HTTP_SERVER_ERROR ? "temporarily_unavailable" : "invalid_request"
    return yield* HardcoverOAuthError.make({
      code: Predicate.isString(fields.error) ? fields.error : fallback,
      description: Predicate.isString(fields.error_description) ? fields.error_description : `HTTP ${response.status}`,
      status: response.status,
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: TIMEOUT,
      orElse: () =>
        Effect.fail(HardcoverOAuthError.make({ code: "temporarily_unavailable", description: TIMED_OUT, status: NETWORK_STATUS })),
    }),
  )

/**
 * A token response as a `TokenSet`, failing when a token is missing.
 * @param {FormFields} body The token response.
 * @returns {Effect.Effect<TokenSet, HardcoverOAuthError>} The tokens.
 */
const toTokenSet = (body: FormFields): Effect.Effect<TokenSet, HardcoverOAuthError> =>
  Effect.gen(function* readTokens() {
    const { access_token: accessToken, expires_in: expiresIn, refresh_token: refreshToken, scope } = body
    if (!Predicate.isString(accessToken) || !Predicate.isString(refreshToken)) {
      return yield* HardcoverOAuthError.make({
        code: "invalid_response",
        description: "token response is missing access_token or refresh_token",
        status: INVALID_RESPONSE_STATUS,
      })
    }
    const ttlSeconds = Predicate.isNumber(expiresIn) && expiresIn > NO_TTL ? expiresIn : DEFAULT_TTL_SECONDS
    const now = yield* Clock.currentTimeMillis
    return {
      accessToken,
      accessTokenExpiresAt: now + ttlSeconds * MILLIS_PER_SECOND,
      refreshToken,
      scope: pipe(
        Option.liftPredicate(scope, Predicate.isString),
        Option.map((granted) =>
          pipe(
            granted.split(" "),
            Arr.filter((part) => part !== ""),
          ),
        ),
      ),
    }
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { discover, postForm, revocationEndpoint, toTokenSet }
