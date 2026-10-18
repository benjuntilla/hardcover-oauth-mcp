/**
 * What Hardcover's OAuth calls return, and how they fail.
 */
import type { Option } from "effect"
import { Schema } from "effect"

/** The grant's own failure. Others, such as `invalid_client`, are this server's and leave connections alone. */
const GRANT_GONE = "invalid_grant"

interface TokenSet {
  readonly accessToken: string
  readonly refreshToken: string
  /** Epoch milliseconds. */
  readonly accessTokenExpiresAt: number
  /** The scopes Hardcover says it granted, when it says. */
  readonly scope: Option.Option<ReadonlyArray<string>>
}

/**
 * A failed call to Hardcover's OAuth endpoints. `permanent` means the grant is
 * gone (`invalid_grant`: revoked, expired, or a replayed refresh token) and the
 * user must sign in again; anything else may succeed on retry.
 */
class HardcoverOAuthError extends Schema.TaggedError<HardcoverOAuthError, { readonly brand: unique symbol }>()("HardcoverOAuthError", {
  code: Schema.String,
  description: Schema.String,
  status: Schema.Finite,
}) {
  /**
   * Whether the grant is gone and the user must sign in again.
   * @returns {boolean} True for a revoked, expired, or replayed grant.
   */
  public get permanent(): boolean {
    return this.code === GRANT_GONE
  }

  /**
   * The message shown in logs and in refresh failures.
   * @returns {string} The code, with the description when there is one.
   */
  public override get message(): string {
    return `Hardcover OAuth ${this.code}${this.description === "" ? "" : `: ${this.description}`}`
  }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { HardcoverOAuthError }
/**
 * Application module, not a public API.
 * @internal
 */
export type { TokenSet }
