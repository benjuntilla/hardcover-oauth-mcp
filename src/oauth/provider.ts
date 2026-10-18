/**
 * The MCP-facing OAuth 2.1 authorization server and protected resource, both
 * from `OAuthProvider`. MCP clients register (DCR or Client ID Metadata
 * Documents), authorize here, and receive tokens for `<origin>/mcp`; they never
 * see a Hardcover token.
 */
import { OAuthError, OAuthProvider } from "@cloudflare/workers-oauth-provider"
import { Option, Schema } from "effect"
import type { Env } from "#src/env.ts"
import { IDLE_TTL_MS } from "#src/connection/state.ts"
import { SUPPORTED_SCOPES } from "#src/hardcover/scopes.ts"
import { defaultHandler } from "#src/oauth/authorize.ts"
import { mcpApiHandler } from "#src/mcp/api-handler.ts"
import { publicOrigin } from "#src/oauth/origin.ts"

const MILLIS_PER_SECOND = 1000
const ACCESS_TOKEN_TTL = 3600
const REFRESH_GRANT = "refresh_token"
const PUBLIC_FETCH_FLAG = "global_fetch_strictly_public"

declare const Cloudflare: { readonly compatibilityFlags?: Readonly<Record<string, boolean>> } | undefined

/**
 * CIMD fetches client-chosen URLs, so the library only allows it with `global_fetch_strictly_public`.
 * @returns {boolean} Whether that flag is on.
 */
const cimdAvailable = (): boolean => {
  const cloudflare = Option.fromNullishOr(Cloudflare)
  return Option.isSome(cloudflare) && cloudflare.value.compatibilityFlags?.[PUBLIC_FETCH_FLAG] === true
}

const Grant = Schema.Struct({ connectionId: Schema.String })

/**
 * Refuses an MCP refresh once the Hardcover connection is gone, so the client re-authorizes. On the
 * `invalid_grant` thrown here, `OAuthProvider` revokes the grant and its tokens in KV before answering
 * (and still answers `invalid_grant` if that fails), so the grant's user id, username, and scopes go too.
 * @param {Readonly<{ grantType: string; props: unknown; env: Env }>} options The exchange.
 * @returns {Promise<void>} Resolves when the grant may continue. Grant props without a connection are a defect.
 */
const refuseStale = (options: Readonly<{ env: Env; grantType: string; props: unknown }>): Promise<void> => {
  if (options.grantType !== REFRESH_GRANT) {
    return Promise.resolve()
  }
  return Schema.decodeUnknownPromise(Grant)(options.props)
    .then((props) => options.env.HARDCOVER_CONNECTION.getByName(props.connectionId).status())
    .then((status) => {
      if (status === "active") {
        return
      }
      throw new OAuthError("invalid_grant", { description: "The Hardcover connection was revoked or expired; connect again." })
    })
}

/**
 * The provider for one public origin.
 * @param {string} origin The origin tokens are issued for.
 * @returns {OAuthProvider<Env>} The provider.
 */
const make = (origin: string): OAuthProvider<Env> =>
  new OAuthProvider<Env>({
    accessTokenTTL: ACCESS_TOKEN_TTL,
    apiHandler: mcpApiHandler,
    apiRoute: "/mcp",
    authorizeEndpoint: "/authorize",
    clientIdMetadataDocumentEnabled: cimdAvailable(),
    clientRegistrationEndpoint: "/register",
    defaultHandler,
    // Each refresh extends the grant, so a connection lives while it is used.
    refreshTokenIdleTTL: IDLE_TTL_MS / MILLIS_PER_SECOND,
    refreshTokenTTL: IDLE_TTL_MS / MILLIS_PER_SECOND,
    resourceMetadata: { resource: `${origin}/mcp`, resource_name: "Hardcover" },
    scopesSupported: [...SUPPORTED_SCOPES],
    tokenEndpoint: "/token",
    /* An MCP refresh is refused once the Hardcover side is gone, so clients re-authorize
       instead of holding tokens that can never call Hardcover again. */
    tokenExchangeCallback: (options) => refuseStale(options),
  })

const providers = new Map<string, OAuthProvider<Env>>()

/**
 * One provider per public origin (normally exactly one), built on first use because the resource URL depends on it.
 * @param {object} options The deployment and the request.
 * @param {Env} options.env The Worker bindings.
 * @param {URL} options.url The request URL.
 * @returns {OAuthProvider<Env>} The provider.
 */
const providerFor = (options: { readonly env: Env; readonly url: URL }): OAuthProvider<Env> => {
  const origin = publicOrigin(options)
  const existing = Option.fromNullishOr(providers.get(origin))
  if (Option.isSome(existing)) {
    return existing.value
  }
  const provider = make(origin)
  providers.set(origin, provider)
  return provider
}

/**
 * Application module, not a public API.
 * @internal
 */
export { providerFor }
