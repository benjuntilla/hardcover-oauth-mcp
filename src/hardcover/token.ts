/**
 * The bearer token one Hardcover GraphQL call sends.
 */
import { Context } from "effect"

/** The access token for one call, provided through the client method's `context` option. */
class Token extends Context.Service<Token, string>()("hardcover-oauth-mcp/hardcover/token") {}

/**
 * Application module, not a public API.
 * @internal
 */
export { Token }
