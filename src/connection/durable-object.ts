/**
 * One `HardcoverConnection` per MCP grant (named by `GrantProps.connectionId`).
 *
 * It is the only place a Hardcover refresh token lives, so refreshes are
 * single-flight: Hardcover rotates refresh tokens and revokes the whole chain
 * when one is replayed, which a token copied into several KV records or
 * refreshed by concurrent requests would eventually do.
 *
 * It also serves the connection's `/mcp` requests (forwarded by the Worker
 * after authentication), so Hardcover calls start next to the tokens and the
 * 2025 protocol revisions' sessions live in this object's memory. When the
 * object is evicted those sessions end, and clients start new ones.
 */
import { Clock, Effect, Option, Predicate } from "effect"
import { REVOKED, disconnectConnection, refreshConnection } from "#src/connection/tokens.ts"
import { ConnectionStore } from "#src/connection/storage.ts"
import { DurableObject } from "cloudflare:workers"
import type { Env } from "#src/env.ts"
import type { ForwardedGrant } from "#src/connection/grant.ts"
import type { HttpClient } from "effect/http"
import { IDLE_TTL_MS } from "#src/connection/state.ts"
import { McpServers } from "#src/connection/mcp.ts"
import type { StoredTokens } from "#src/connection/state.ts"
import { hardcoverEndpoints } from "#src/env.ts"
import { platform } from "#src/platform.ts"

/** Refresh this long before Hardcover's access token (one week) expires. */
const REFRESH_EARLY_MS = 600_000

type AccessTokenResult =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "revoked" | "unavailable"; readonly message: string }

/** Whether the connection exists; one Hardcover refused has been erased. */
type ConnectionStatus = "active" | "missing"

/** What `/callback` learned about a fresh authorization. */
interface ConnectionInit {
  readonly hcUserId: number
  readonly username: string
  readonly tokens: StoredTokens
}

/** The Durable Object. */
class HardcoverConnection extends DurableObject<Env> {
  readonly #store = new ConnectionStore(this.ctx.storage)
  readonly #servers = new McpServers({
    accessToken: (rejected?: string): Promise<AccessTokenResult> => this.accessToken(rejected),
    url: this.env.HARDCOVER_GRAPHQL_URL,
  })
  #refreshing: Option.Option<Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient>> = Option.none()

  /**
   * Stores the tokens from a fresh authorization. Called once, from `/callback`.
   * @param {ConnectionInit} input The account and its tokens.
   * @returns {Promise<void>} Resolves once stored.
   */
  public init(input: ConnectionInit): Promise<void> {
    const store = this.#store
    return platform.runPromise(
      Effect.gen(function* storeConnection() {
        const now = yield* Clock.currentTimeMillis
        yield* store.save({
          accessToken: input.tokens.accessToken,
          accessTokenExpiresAt: input.tokens.accessTokenExpiresAt,
          createdAt: now,
          hcUserId: input.hcUserId,
          lastUsedAt: now,
          refreshToken: input.tokens.refreshToken,
          username: input.username,
        })
        yield* store.setAlarm(now + IDLE_TTL_MS)
      }),
    )
  }

  /**
   * A Hardcover access token to call the API with. Pass the token Hardcover just
   * answered `401` to as `rejected`: the connection refreshes only if that is
   * still the current token, so concurrent callers share one refresh.
   * @param {string} rejected The token Hardcover refused, when this follows a 401.
   * @returns {Promise<AccessTokenResult>} The token, or why there isn't one.
   */
  public accessToken(rejected?: string): Promise<AccessTokenResult> {
    return platform.runPromise(
      Effect.gen({ self: this }, function* currentToken() {
        const loaded = yield* this.#store.load()
        if (Option.isNone(loaded)) {
          return REVOKED
        }
        const state = loaded.value
        yield* this.#store.touch()
        const now = yield* Clock.currentTimeMillis
        const stale = Predicate.isUndefined(rejected)
          ? state.accessTokenExpiresAt - REFRESH_EARLY_MS <= now
          : rejected === state.accessToken
        if (!stale) {
          return { ok: true, token: state.accessToken } as const
        }
        return yield* this.#sharedRefresh()
      }),
    )
  }

  /**
   * The refresh in flight, or a new one that later callers share until it ends.
   * @returns {Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient>} The refresh's result.
   */
  #sharedRefresh(): Effect.Effect<AccessTokenResult, never, HttpClient.HttpClient> {
    return Effect.suspend(() =>
      Option.match(this.#refreshing, {
        onNone: () => {
          const refresh = refreshConnection({ endpoints: hardcoverEndpoints(this.env), store: this.#store }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                this.#refreshing = Option.none()
              }),
            ),
          )
          return Effect.flatMap(Effect.cached(refresh), (shared) => {
            this.#refreshing = Option.some(shared)
            return shared
          })
        },
        onSome: (shared) => shared,
      }),
    )
  }

  /**
   * Serves a `/mcp` request the Worker has authenticated and forwarded.
   * @param {Request} request The forwarded request, without the bearer token.
   * @param {ForwardedGrant} grant What the MCP access token grants.
   * @returns {Promise<Response>} The MCP response.
   */
  public serve(request: Request, grant: ForwardedGrant): Promise<Response> {
    return platform.runPromise(this.#servers.serve(request, grant, this.#store))
  }

  /**
   * Whether the MCP grant may keep refreshing. Called from the token endpoint on every MCP refresh.
   * @returns {Promise<ConnectionStatus>} The status.
   */
  public status(): Promise<ConnectionStatus> {
    const store = this.#store
    return platform.runPromise(
      Effect.gen(function* connectionStatus() {
        const loaded = yield* store.load()
        if (Option.isNone(loaded)) {
          return "missing"
        }
        yield* store.touch()
        return "active"
      }),
    )
  }

  /**
   * Revokes the Hardcover tokens, best effort, and erases the connection.
   * @returns {Promise<void>} Resolves once erased.
   */
  public disconnect(): Promise<void> {
    return platform.runPromise(disconnectConnection({ endpoints: hardcoverEndpoints(this.env), store: this.#store }))
  }

  /**
   * Revokes and erases the connection once it has been idle for its lifetime.
   * @returns {Promise<void>} Resolves once handled.
   */
  public override alarm(): Promise<void> {
    const store = this.#store
    const disconnect = disconnectConnection({ endpoints: hardcoverEndpoints(this.env), store })
    return platform.runPromise(
      Effect.gen(function* idleCheck() {
        const loaded = yield* store.load()
        if (Option.isNone(loaded)) {
          return
        }
        const idleUntil = loaded.value.lastUsedAt + IDLE_TTL_MS
        const now = yield* Clock.currentTimeMillis
        if (idleUntil > now) {
          yield* store.setAlarm(idleUntil)
          return
        }
        yield* disconnect
      }),
    )
  }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { HardcoverConnection }
/**
 * Application module, not a public API.
 * @internal
 */
export type { AccessTokenResult }
