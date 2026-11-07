/**
 * The connection's `@hardcover/sdk` client. The Durable Object still owns the
 * refresh token; this client asks it for an access token and, on a 401, for a
 * fresh one. The SDK then paces, retries, and maps errors.
 */
import {
  ActionError,
  AuthenticationError,
  GraphQLError,
  HardcoverClient,
  InvalidRequestError,
  NetworkError,
  NotFoundError,
  RateLimitError,
  RequestTooLargeError,
  ScopeError,
  HardcoverError as SdkHardcoverError,
  SignedOutError,
  TimeoutError,
  UnsupportedOperationError,
} from "@hardcover/sdk"
import { Array as Arr, Effect, Option, Predicate, pipe } from "effect"
import type { AccessTokenResult } from "#src/connection/durable-object.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import { USER_AGENT } from "#src/env.ts"

/** How a tool reaches Hardcover: the SDK client, plus the connection's user id. */
interface Hardcover {
  readonly client: HardcoverClient
  readonly userId: number
}

interface ClientSource {
  readonly url: string
  /** A token fetched earlier in this request, to save a Durable Object round trip. */
  readonly initialToken?: string | undefined
  readonly accessToken: (rejected?: string) => Promise<AccessTokenResult>
}

const MESSAGE_SEPARATOR = "; "
const ADVICE: Readonly<Record<string, (error: SdkHardcoverError) => string>> = {
  ActionError: (error) =>
    error instanceof ActionError ? `Hardcover: ${pipe(error.messages, Arr.join(MESSAGE_SEPARATOR))}` : error.message,
  AuthenticationError: () => "Hardcover refused the session. Reconnect the MCP server.",
  GraphQLError: (error) =>
    error instanceof GraphQLError
      ? pipe(
          error.errors,
          Arr.map((item) => item.message),
          Arr.join(MESSAGE_SEPARATOR),
        )
      : error.message,
  InvalidRequestError: (error) => error.message,
  NetworkError: (error) =>
    `${error.message}${error instanceof NetworkError && error.mayHaveSucceeded ? " The change may or may not have been applied; check before retrying." : ""}`,
  NotFoundError: (error) => error.message,
  RateLimitError: (error) =>
    error instanceof RateLimitError
      ? `Hardcover's ${error.window} limit is spent. Wait ${error.retryAfterSeconds} seconds.`
      : error.message,
  RequestTooLargeError: () => "The request has more top-level fields than this account's burst limit. Split it.",
  ScopeError: (error) =>
    error instanceof ScopeError
      ? `This connection lacks permission: ${pipe(error.missingScopes, Arr.join(", "))}. Reconnect the MCP server and grant those scopes.`
      : error.message,
  ServerError: (error) => `${error.message} Try again shortly.`,
  SignedOutError: () => "The Hardcover session ended. Reconnect the MCP server.",
  TimeoutError: (error) =>
    `${error.message}${error instanceof TimeoutError && error.mayHaveSucceeded ? " The change may or may not have been applied; check before retrying." : ""}`,
  UnsupportedOperationError: (error) => error.message,
}

const invalidKinds: ReadonlySet<string> = new Set([
  ActionError.name,
  InvalidRequestError.name,
  GraphQLError.name,
  RequestTooLargeError.name,
  UnsupportedOperationError.name,
])

const isInvalid = (error: SdkHardcoverError): boolean => invalidKinds.has(error.name)

const messageOf = (error: SdkHardcoverError): string => {
  const advice = ADVICE[error.name]
  return Predicate.isUndefined(advice) ? error.message : advice(error)
}

const sessionKind = (error: SdkHardcoverError): Option.Option<HardcoverError["kind"]> => {
  if (error instanceof SignedOutError || error instanceof AuthenticationError) {
    return Option.some("reauth")
  }
  if (error instanceof ScopeError) {
    return Option.some("forbidden")
  }
  return Option.none()
}

const requestKind = (error: SdkHardcoverError): Option.Option<HardcoverError["kind"]> => {
  if (error instanceof NotFoundError) {
    return Option.some("not_found")
  }
  if (isInvalid(error)) {
    return Option.some("invalid")
  }
  if (error instanceof RateLimitError) {
    return Option.some("rate_limited")
  }
  if (error instanceof TimeoutError) {
    return Option.some("timeout")
  }
  return Option.none()
}

const kindOf = (error: SdkHardcoverError): HardcoverError["kind"] =>
  Option.getOrElse(Option.firstSomeOf([sessionKind(error), requestKind(error)]), () => "unavailable" as const)

/**
 * A tool error from an SDK error, with the advice the model can act on.
 * @param {unknown} error What the SDK threw.
 * @returns {HardcoverError} The tool error.
 */
const fromSdk = (error: unknown): HardcoverError => {
  if (!(error instanceof SdkHardcoverError)) {
    return HardcoverError.make({ kind: "unavailable", message: "Could not reach Hardcover. Try again shortly." })
  }
  return HardcoverError.make({ kind: kindOf(error), message: messageOf(error) })
}

/**
 * Runs an SDK call and turns its errors into this server's tool errors.
 * @param {Function} attempt The SDK call.
 * @returns {Effect.Effect} Its result.
 */
const sdk = <Result>(attempt: () => Promise<Result>): Effect.Effect<Result, HardcoverError> =>
  Effect.tryPromise({ catch: fromSdk, try: attempt })

/**
 * The token, or the error the SDK should throw when the connection has none.
 * @param {AccessTokenResult} result What the connection returned.
 * @returns {string} The access token.
 */
const accepted = (result: AccessTokenResult): string => {
  if (!result.ok) {
    throw result.reason === "revoked" ? new SignedOutError("revoked") : new SdkHardcoverError(result.message)
  }
  return result.token
}

/**
 * The SDK client for one connection.
 * @param {ClientSource} source The GraphQL URL and the connection's token source.
 * @param {number} userId The signed-in user's Hardcover id.
 * @returns {Hardcover} The client.
 */
const makeHardcover = (source: Readonly<ClientSource>, userId: number): Hardcover => {
  const client = new HardcoverClient({
    auth: {
      // The connection refreshes a token that is about to expire. Asking every time keeps concurrent callers on one refresh.
      getAccessToken: (): Promise<string> => source.accessToken().then(accepted),
      refreshAfterUnauthorized: (rejected: string): Promise<string> => {
        // `me` is cached for the life of the client; a refused token means that cache is stale.
        client.me.forget()
        return source.accessToken(rejected).then(accepted)
      },
    },
    // Off until the SDK replays a batched 401 after refresh. Concurrent reads would otherwise share one failed batch.
    batch: false,
    endpoint: source.url,
    userAgent: USER_AGENT,
  })
  return { client, userId }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { makeHardcover, sdk }
/**
 * Application module, not a public API.
 * @internal
 */
export type { Hardcover }
