/**
 * The connection's MCP servers: one per scope set, each with a GraphQL executor
 * that takes its tokens from the connection.
 */
import { Array as Arr, Effect, Option, Order, pipe } from "effect"
import type { AccessTokenResult } from "#src/connection/durable-object.ts"
import type { ConnectionState } from "#src/connection/state.ts"
import type { ConnectionStore } from "#src/connection/storage.ts"
import type { ForwardedGrant } from "#src/connection/grant.ts"
import type { McpHandler } from "#src/mcp/server.ts"
import { REVOKED_MESSAGE } from "#src/connection/state.ts"
import { makeExecutor } from "#src/hardcover/client.ts"
import { makeMcpHandler } from "#src/mcp/server.ts"
import { reauthorize } from "#src/mcp/jsonrpc.ts"

/** Where the executors send documents, and how they get tokens. */
interface ServerOptions {
  readonly url: string
  readonly accessToken: (rejected?: string) => Promise<AccessTokenResult>
}

/** The servers of one connection. */
class McpServers {
  readonly #options: ServerOptions
  /** A refreshed token can carry fewer scopes than the grant, so there is one server per scope set. */
  readonly #servers = new Map<string, McpHandler>()

  /**
   * Servers for one connection.
   * @param {ServerOptions} options The GraphQL endpoint and the connection's token source.
   */
  public constructor(options: ServerOptions) {
    this.#options = options
  }

  /**
   * Serves a `/mcp` request the Worker has authenticated and forwarded.
   * @param {Request} request The forwarded request.
   * @param {ForwardedGrant} grant What the MCP access token grants.
   * @param {ConnectionStore} store The connection's storage.
   * @returns {Effect.Effect<Response>} The MCP response.
   */
  public serve(request: Request, grant: ForwardedGrant, store: ConnectionStore): Effect.Effect<Response> {
    return Effect.gen({ self: this }, function* serveRequest() {
      const state = yield* store.load()
      if (Option.isNone(state)) {
        return reauthorize({ description: REVOKED_MESSAGE, request })
      }
      const server = this.#serverFor(grant, state.value)
      return yield* Effect.promise(() => server.handler(request))
    })
  }

  /**
   * The server for one scope set, built on first use.
   * @param {ForwardedGrant} grant The grant.
   * @param {ConnectionState} state The connection.
   * @returns {McpHandler} The server.
   */
  #serverFor(grant: ForwardedGrant, state: ConnectionState): McpHandler {
    const key = pipe(grant.scopes, Arr.sortBy(Order.String), Arr.join(" "))
    return Option.getOrElse(Option.fromNullishOr(this.#servers.get(key)), () => {
      const server = makeMcpHandler({
        graphql: makeExecutor(this.#options),
        hcUserId: state.hcUserId,
        librarianRoles: grant.librarianRoles,
        scopes: new Set(grant.scopes),
        supporter: grant.supporter,
        username: state.username,
      })
      this.#servers.set(key, server)
      return server
    })
  }
}

/**
 * Application module, not a public API.
 * @internal
 */
export { McpServers }
