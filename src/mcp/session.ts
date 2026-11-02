import { Context } from "effect"
import type { Hardcover } from "#src/hardcover/sdk.ts"

interface SessionShape {
  readonly hcUserId: number
  readonly username: string
  readonly scopes: ReadonlySet<string>
  readonly supporter: boolean
  readonly librarianRoles: ReadonlyArray<string> | null
  /** The connection's SDK client. Raw GraphQL tools use `client.graphql`. */
  readonly hardcover: Hardcover
}

/**
 * The authenticated MCP request: who is calling, with which scopes, and their Hardcover client.
 *
 * Application module, not a public API.
 * @internal
 */
class Session extends Context.Service<Session, SessionShape>()("hardcover-oauth-mcp/mcp/session") {}

/**
 * Application module, not a public API.
 * @internal
 */
export { Session }
