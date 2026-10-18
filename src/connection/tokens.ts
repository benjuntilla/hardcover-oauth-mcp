/**
 * The connection's Hardcover tokens: the refresh that rotates them, and the
 * revocation when the connection ends.
 */
import { Cause, Effect, Option, Schema } from "effect"
import { REVOKED_MESSAGE, rotated } from "#src/connection/state.ts"
import { refreshTokens, revokeToken } from "#src/hardcover/oauth-calls.ts"
import type { AccessTokenResult } from "#src/connection/durable-object.ts"
import type { ConnectionStore } from "#src/connection/storage.ts"
import type { HardcoverEndpoints } from "#src/env.ts"
import { HardcoverOAuthError } from "#src/hardcover/oauth-types.ts"
import type { HttpClient } from "effect/http"
import type { StoredTokens } from "#src/connection/state.ts"

const HTTP_SERVER_ERROR = 500

/** No token: the connection is missing or Hardcover refused it. */
const REVOKED: AccessTokenResult = { message: REVOKED_MESSAGE, ok: false, reason: "revoked" }

/** What the token calls need: the connection's storage and Hardcover's endpoints. */
interface TokenOptions {
  readonly store: ConnectionStore
  readonly endpoints: HardcoverEndpoints
}

/**
 * A refresh that failed. A refused grant erases the connection.
 * @param {object} failure The failed refresh.
 * @param {ConnectionStore} failure.store The connection's storage.
 * @param {unknown} failure.error What the refresh failed with.
 * @returns {Effect.Effect<AccessTokenResult>} Why there is no token.
 */
const refreshFailed = (failure: { readonly store: ConnectionStore; readonly error: unknown }): Effect.Effect<AccessTokenResult> => {
  const { error, store } = failure
  const oauth = Schema.is(HardcoverOAuthError)(error)
  // The grant is gone at Hardcover, so the connection is erased; its token can't be revoked any further.
  if (oauth && error.permanent) {
    return Effect.as(store.forget(), REVOKED)
  }
  // Hardcover being unreachable or failing (5xx) happens; a response we don't understand is a bug.
  const defect = !oauth || error.code === "invalid_response" || error.status < HTTP_SERVER_ERROR
  const detail = error instanceof Error ? error.message : String(error)
  const result: AccessTokenResult = {
    message: `Could not refresh the Hardcover session (${detail}). Try again shortly.`,
    ok: false,
    reason: "unavailable",
  }
  const report = defect ? Effect.logError("[hardcover-oauth-mcp] defect: token refresh failed:", error) : Effect.void
  return Effect.as(report, result)
}

/**
 * Stores rotated tokens on the connection as it is now, since calls during the refresh may have
 * changed it. A connection erased meanwhile stays erased, and its new refresh token is revoked, best effort.
 * @param {object} rotation The refresh's outcome.
 * @param {TokenOptions["store"]} rotation.store The connection's storage.
 * @param {TokenOptions["endpoints"]} rotation.endpoints Hardcover's endpoints.
 * @param {StoredTokens} rotation.tokens The rotated tokens.
 * @returns {Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient>} The new token, or why there is none.
 */
const storeRotated = (
  rotation: TokenOptions & { readonly tokens: StoredTokens },
): Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* storeTokens() {
    const { endpoints, store, tokens } = rotation
    const current = yield* store.load()
    if (Option.isNone(current)) {
      yield* Effect.ignoreCause(revokeToken({ endpoints, token: tokens.refreshToken }))
      return REVOKED
    }
    yield* store.save(rotated(current.value, tokens))
    return { ok: true, token: tokens.accessToken } as const
  })

/**
 * Spends the refresh token and stores the rotated set before anyone uses it. Never interrupted
 * halfway: a spent refresh token that isn't replaced would end the connection.
 * @param {TokenOptions} options The connection's storage and Hardcover's endpoints.
 * @returns {Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient>} The new token, or why there is none.
 */
const refreshConnection = (options: TokenOptions): Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* refreshToken() {
    const { endpoints, store } = options
    const loaded = yield* store.load()
    if (Option.isNone(loaded)) {
      return REVOKED
    }
    return yield* refreshTokens({ endpoints, refreshToken: loaded.value.refreshToken }).pipe(
      Effect.flatMap((tokens) => storeRotated({ endpoints, store, tokens })),
      Effect.catchCause((cause) => refreshFailed({ error: Cause.squash(cause), store })),
    )
  }).pipe(Effect.uninterruptible)

/**
 * Revokes the Hardcover tokens, best effort, and erases the connection.
 * @param {TokenOptions} options The connection's storage and Hardcover's endpoints.
 * @returns {Effect.Effect<void, never, HttpClient.HttpClient>} Done once erased.
 */
const disconnectConnection = (options: TokenOptions): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* disconnect() {
    const loaded = yield* options.store.load()
    if (Option.isSome(loaded)) {
      yield* Effect.ignoreCause(revokeToken({ endpoints: options.endpoints, token: loaded.value.refreshToken }))
    }
    yield* options.store.forget()
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { REVOKED, disconnectConnection, refreshConnection }
