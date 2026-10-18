import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import type { WorkerEnv } from "#root/alchemy.run.ts"

const TRAILING_SLASHES = /\/+$/v

/** Worker bindings declared in `alchemy.run.ts`, plus the helpers `OAuthProvider` injects. */
type Env = WorkerEnv & { readonly OAUTH_PROVIDER: OAuthHelpers }

/** What `completeAuthorization()` stores with each MCP grant; handlers read it as `ctx.props`. */
interface GrantProps {
  readonly hcUserId: number
  readonly username: string
  /** Name of the `HardcoverConnection` Durable Object holding this grant's Hardcover tokens. */
  readonly connectionId: string
  /** Supporter (paid) status when the grant was made. */
  readonly supporter: boolean
  /** Librarian roles when the grant was made, or `null` when `read:me:roles` was not granted. */
  readonly librarianRoles: ReadonlyArray<string> | null
}

const USER_AGENT = "hardcover-oauth-mcp/0.1 (+https://github.com/benjuntilla/hardcover-oauth-mcp)"

interface HardcoverEndpoints {
  readonly issuer: string
  readonly graphqlUrl: string
  readonly clientId: string
  readonly clientSecret: string
}

/**
 * Hardcover's configured endpoints, with trailing slashes stripped from the issuer.
 * @param {Env} env The Worker bindings.
 * @returns {HardcoverEndpoints} The endpoints for this deployment.
 */
const hardcoverEndpoints = (env: Env): HardcoverEndpoints => ({
  clientId: env.HARDCOVER_CLIENT_ID,
  clientSecret: env.HARDCOVER_CLIENT_SECRET,
  graphqlUrl: env.HARDCOVER_GRAPHQL_URL,
  issuer: env.HARDCOVER_ISSUER.replace(TRAILING_SLASHES, ""),
})

/**
 * Application module, not a public API.
 * @internal
 */
export { USER_AGENT, hardcoverEndpoints }
/**
 * Application module, not a public API.
 * @internal
 */
export type { Env, GrantProps, HardcoverEndpoints }
