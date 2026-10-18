/**
 * Executes GraphQL against Hardcover for one MCP connection: attaches the
 * connection's access token, refreshes once on `401`, waits out short rate
 * limits, and turns every failure into a `HardcoverError` with advice.
 * Mutations are never retried after a timeout or server error, since they may
 * already have been applied.
 *
 * Each document is sent through Effect's GraphQL client (`src/hardcover/transport.ts`).
 */
import { Array as Arr, Duration, Effect, Option, Order, Ref, Struct, pipe } from "effect"
import { Replies, operationName, runDocument } from "#src/hardcover/transport.ts"
import type { AccessTokenResult } from "#src/connection/durable-object.ts"
import type { GraphQLRequest } from "#src/hardcover/graphql.ts"
import type { HardcoverAnswer } from "#src/hardcover/transport.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { Headers } from "effect/http"
import type { HttpClient } from "effect/http"
import { interpret } from "#src/hardcover/response.ts"
import { platform } from "#src/platform.ts"

type ExecuteGraphQL = (request: GraphQLRequest, options?: { readonly mutation?: boolean }) => Effect.Effect<unknown, HardcoverError>

interface ClientOptions {
  readonly url: string
  /** A token fetched earlier in this request, to save a Durable Object round trip. */
  readonly initialToken?: string | undefined
  readonly accessToken: (rejected?: string) => Promise<AccessTokenResult>
}

/** Longest wait worth sitting out inside a tool call. */
const MAX_INLINE_WAIT_SECONDS = 5
const MAX_RATE_LIMIT_RETRIES = 2
const MAX_SERVER_RETRIES = 1
/** The wait for a 429 that names none. */
const DEFAULT_WAIT_SECONDS = 1
const SERVER_RETRY_SECONDS = 1
const NO_RETRIES = 0
const ONE_MORE = 1
const NO_WAIT = 0
const HTTP_UNAUTHORIZED = 401
const HTTP_TOO_MANY = 429
const HTTP_UNAVAILABLE = 503
const RATE_LIMIT_WAITS = /t=(?<seconds>\d+)/gv
const DAILY_LIMIT = /"daily";r=0\b/v
const MAY_HAVE_APPLIED = " The change may or may not have been applied; check before retrying."

/** One document's call: what to send, and how to get a fresh token. */
interface Call {
  readonly mutation: boolean
  readonly operation: string
  readonly request: GraphQLRequest
  readonly token: (rejected: Option.Option<string>) => Effect.Effect<string, HardcoverError>
  readonly url: string
}

/** The token and retry counts of one attempt. */
interface Attempt {
  readonly accessToken: string
  readonly refreshed: boolean
  readonly rateLimitRetries: number
  readonly serverRetries: number
}

/**
 * A header's value, or empty.
 * @param {globalThis.Headers | Headers.Headers} headers The response headers.
 * @param {string} name The header name, lower case.
 * @returns {string} The value.
 */
const header = (headers: globalThis.Headers | Headers.Headers, name: string): string =>
  Option.getOrElse(Headers.get(Headers.fromInput(headers), name), () => "")

/**
 * Seconds until the next request may succeed, from `Retry-After` or the IETF `RateLimit` header (`t=`).
 * @param {globalThis.Headers | Headers.Headers} headers The response headers.
 * @returns {Option.Option<number>} The wait, or none when neither header gives one.
 */
const waitSeconds = (headers: globalThis.Headers | Headers.Headers): Option.Option<number> => {
  const stated = Number(header(headers, "retry-after"))
  if (Number.isFinite(stated) && stated > NO_WAIT) {
    return Option.some(stated)
  }
  const waits = pipe(
    [...header(headers, "ratelimit").matchAll(RATE_LIMIT_WAITS)],
    Arr.map((match) => Number(match.groups?.seconds)),
    Arr.filter((wait) => wait > NO_WAIT),
  )
  return Arr.isReadonlyArrayNonEmpty(waits) ? Option.some(pipe(waits, Arr.max(Order.Number))) : Option.none()
}

/**
 * Seconds until the next request may succeed, from `Retry-After` or the IETF `RateLimit` header (`t=`).
 * @param {globalThis.Headers | Headers.Headers} headers The response headers.
 * @returns {number | undefined} The wait, or undefined when neither header gives one.
 */
const retryAfterSeconds = (headers: globalThis.Headers | Headers.Headers): number | undefined => Option.getOrUndefined(waitSeconds(headers))

/**
 * Whether Hardcover's daily limit, rather than a short burst, is the one that ran out.
 * @param {Headers.Headers} headers The response headers.
 * @returns {boolean} True when the daily bucket is empty.
 */
const isDailyLimit = (headers: Headers.Headers): boolean => DAILY_LIMIT.test(header(headers, "ratelimit"))

/**
 * No answer from Hardcover, as a tool error.
 * @param {boolean} timedOut Whether the request ran out of time.
 * @param {boolean} mutation Whether the operation changes data.
 * @returns {HardcoverError} The failure.
 */
const unreachable = (timedOut: boolean, mutation: boolean): HardcoverError =>
  HardcoverError.make({
    kind: "timeout",
    message:
      (timedOut ? "Hardcover did not answer in time." : "Could not reach Hardcover.") +
      (mutation ? MAY_HAVE_APPLIED : " Try again shortly."),
  })

/**
 * The next attempt after a short 429, or none when the wait is too long or the daily limit ran out.
 * @param {Attempt} attempt The attempt that was refused.
 * @param {HardcoverAnswer} answer The answer.
 * @returns {Effect.Effect<Option.Option<Attempt>>} The next attempt, once the wait is over.
 */
const afterRateLimit = (attempt: Attempt, answer: HardcoverAnswer): Effect.Effect<Option.Option<Attempt>> => {
  const wait = Option.getOrElse(waitSeconds(answer.headers), () => DEFAULT_WAIT_SECONDS)
  if (attempt.rateLimitRetries >= MAX_RATE_LIMIT_RETRIES || isDailyLimit(answer.headers) || wait > MAX_INLINE_WAIT_SECONDS) {
    return Effect.succeedNone
  }
  return Effect.as(
    Effect.sleep(Duration.seconds(wait)),
    Option.some(Struct.evolve(attempt, { rateLimitRetries: (count) => count + ONE_MORE })),
  )
}

/**
 * The next attempt after a 401, a short 429, or a read's 503; none when the answer stands.
 * @param {Call} call The document's call.
 * @param {Attempt} attempt The attempt that got the answer.
 * @param {HardcoverAnswer} answer The answer.
 * @returns {Effect.Effect<Option.Option<Attempt>, HardcoverError>} The next attempt.
 */
const nextAttempt = (call: Call, attempt: Attempt, answer: HardcoverAnswer): Effect.Effect<Option.Option<Attempt>, HardcoverError> => {
  if (answer.status === HTTP_UNAUTHORIZED && !attempt.refreshed) {
    return Effect.map(call.token(Option.some(attempt.accessToken)), (accessToken) =>
      Option.some(Struct.evolve(attempt, { accessToken: () => accessToken, refreshed: () => true })),
    )
  }
  if (answer.status === HTTP_TOO_MANY) {
    return afterRateLimit(attempt, answer)
  }
  // 503 is documented as safe to retry; only reads are retried, once.
  if (answer.status === HTTP_UNAVAILABLE && !call.mutation && attempt.serverRetries < MAX_SERVER_RETRIES) {
    return Effect.as(
      Effect.sleep(Duration.seconds(SERVER_RETRY_SECONDS)),
      Option.some(Struct.evolve(attempt, { serverRetries: (count) => count + ONE_MORE })),
    )
  }
  return Effect.succeedNone
}

/**
 * One attempt, and the next while `nextAttempt` says so.
 * @param {Call} call The document's call.
 * @param {Attempt} attempt The token and retry counts.
 * @returns {Effect.Effect<unknown, HardcoverError, HttpClient.HttpClient>} The `data` object.
 */
const send = (call: Call, attempt: Attempt): Effect.Effect<unknown, HardcoverError, HttpClient.HttpClient> =>
  Effect.gen(function* sendAttempt() {
    const reply = yield* runDocument({
      accessToken: attempt.accessToken,
      mutation: call.mutation,
      request: call.request,
      url: call.url,
    })
    if (Replies.$is("Data")(reply)) {
      return reply.data
    }
    if (Replies.$is("Unreachable")(reply)) {
      return yield* unreachable(reply.timedOut, call.mutation)
    }
    const next = yield* nextAttempt(call, attempt, reply.answer)
    if (Option.isSome(next)) {
      return yield* send(call, next.value)
    }
    const { answer } = reply
    return yield* interpret({
      answer,
      daily: isDailyLimit(answer.headers),
      mutation: call.mutation,
      operation: call.operation,
      wait: waitSeconds(answer.headers),
    })
  })

/**
 * A token from the connection.
 * @param {ClientOptions} options The connection's token source.
 * @param {Option.Option<string>} rejected The token Hardcover just refused.
 * @returns {Effect.Effect<string, HardcoverError>} The token to send.
 */
const loadToken = (options: ClientOptions, rejected: Option.Option<string>): Effect.Effect<string, HardcoverError> =>
  Effect.tryPromise({
    catch: () => HardcoverError.make({ kind: "unavailable", message: "Could not load the Hardcover session. Try again shortly." }),
    try: () => options.accessToken(Option.getOrUndefined(rejected)),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.token)
        : Effect.fail(HardcoverError.make({ kind: result.reason === "revoked" ? "reauth" : "unavailable", message: result.message })),
    ),
  )

/**
 * An executor for one connection. It keeps the last token it was given for later calls.
 * @param {ClientOptions} options The endpoint and the connection's token source.
 * @returns {ExecuteGraphQL} The executor.
 */
const makeExecutor = (options: ClientOptions): ExecuteGraphQL => {
  const held = Ref.makeUnsafe(Option.fromNullishOr(options.initialToken))
  const token = (rejected: Option.Option<string>): Effect.Effect<string, HardcoverError> =>
    Effect.tap(loadToken(options, rejected), (accessToken) => Ref.set(held, Option.some(accessToken)))
  return (request, settings = {}) => {
    const call: Call = { mutation: settings.mutation ?? false, operation: operationName(request), request, token, url: options.url }
    const program = Effect.gen(function* runCall() {
      const current = yield* Ref.get(held)
      const accessToken = Option.isSome(current) ? current.value : yield* token(Option.none())
      return yield* send(call, { accessToken, rateLimitRetries: NO_RETRIES, refreshed: false, serverRetries: NO_RETRIES })
    })
    return platform.contextEffect.pipe(Effect.flatMap((context) => program.pipe(Effect.provideContext(context))))
  }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { makeExecutor, retryAfterSeconds }
/**
 * Application module, not a public API.
 * @internal
 */
export type { ClientOptions, ExecuteGraphQL }
