/**
 * What the Worker learned from the MCP access token, passed with each `/mcp`
 * request it forwards to the connection's Durable Object. It travels as an RPC
 * argument rather than a header, so it stays out of the Durable Object's
 * request logs; only the Worker can call the Durable Object, so it is trusted.
 */
interface ForwardedGrant {
  readonly librarianRoles: ReadonlyArray<string> | null
  readonly scopes: ReadonlyArray<string>
  readonly supporter: boolean
}

/**
 * Application module, not a public API.
 * @internal
 */
export type { ForwardedGrant }
