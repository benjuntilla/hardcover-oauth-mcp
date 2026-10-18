/**
 * The stored shape of one Hardcover connection, and how it changes. A connection
 * Hardcover refuses is erased, so a stored connection is one Hardcover accepted.
 */
import { Function, Schema, Struct } from "effect"
import type { TokenSet } from "#src/hardcover/oauth-types.ts"

const IDLE_DAYS = 150
const HOURS_PER_DAY = 24
const SECONDS_PER_HOUR = 3600
const MILLIS_PER_SECOND = 1000
/** A connection unused for this long is revoked at Hardcover and erased. Matches the MCP grant's idle lifetime. */
const IDLE_TTL_MS = IDLE_DAYS * HOURS_PER_DAY * SECONDS_PER_HOUR * MILLIS_PER_SECOND
const ROTATED_ARITY = 2
const REVOKED_MESSAGE =
  "Hardcover no longer accepts this connection (access was revoked or expired). Reconnect the MCP server to sign in again."

const StoredState = Schema.Struct({
  accessToken: Schema.String,
  accessTokenExpiresAt: Schema.Finite,
  createdAt: Schema.Finite,
  hcUserId: Schema.Finite,
  lastUsedAt: Schema.Finite,
  refreshToken: Schema.String,
  username: Schema.String,
})

type ConnectionState = typeof StoredState.Type

/** The tokens a connection keeps from a `TokenSet`. */
type StoredTokens = Pick<TokenSet, "accessToken" | "accessTokenExpiresAt" | "refreshToken">

/**
 * The state after a successful refresh. The old refresh token is spent.
 * @param {ConnectionState} state The previous state.
 * @param {StoredTokens} tokens The rotated tokens.
 * @returns {ConnectionState} The state to store.
 */
const rotated: {
  (tokens: StoredTokens): (state: ConnectionState) => ConnectionState
  (state: ConnectionState, tokens: StoredTokens): ConnectionState
} = Function.dual(ROTATED_ARITY, (state: ConnectionState, tokens: StoredTokens): ConnectionState =>
  Struct.assign(state, Struct.pick(tokens, ["accessToken", "accessTokenExpiresAt", "refreshToken"])),
)

/**
 * Application module, not a public API.
 * @internal
 */
export { IDLE_TTL_MS, REVOKED_MESSAGE, StoredState, rotated }
/**
 * Application module, not a public API.
 * @internal
 */
export type { ConnectionState, StoredTokens }
