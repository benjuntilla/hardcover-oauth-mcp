/**
 * Token issue and storage for the mock. Refresh tokens rotate, and a reused
 * one is rejected, matching Hardcover.
 */
import { Array as Arr, Option, String as Str, pipe } from "effect"
import { randomEncoded } from "#test/mock-codec.ts"

const ACCESS_PREFIX = "hc_at_"
const CODE_BYTES = 12
const DEFAULT_TTL_SECONDS = 604_800
const OFFLINE_SCOPE = "offline_access"
const OPENID_SCOPE = "openid"
const REFRESH_PREFIX = "hc_rt_"
const SCOPE_SEPARATOR = " "
const TOKEN_BYTES = 12
const TOKEN_TYPE = "Bearer"

interface AuthorizationCode {
  readonly challenge: string
  readonly redirectUri: string
  readonly scope: string
}

interface RefreshGrant {
  scope: string
  spent: boolean
}

interface Issued {
  readonly access_token: string
  readonly expires_in: number
  readonly refresh_token: Option.Option<string>
  readonly scope: string
  readonly token_type: string
}

interface RecordedRequests {
  readonly append: (form: Readonly<Record<string, string>>) => void
}

interface TokenStore {
  readonly accessTokens: Map<string, { readonly scope: string }>
  readonly codes: Map<string, AuthorizationCode>
  readonly issue: (scope: string) => Issued
  readonly refreshTokens: Map<string, RefreshGrant>
}

const includesScope = (scope: string, name: string): boolean => pipe(scope, Str.split(SCOPE_SEPARATOR), Arr.contains(name))

const issued = (options: Readonly<{ access: string; refresh: string; scope: string; ttl: number }>): Issued => ({
  access_token: options.access,
  expires_in: options.ttl,
  refresh_token:
    includesScope(options.scope, OPENID_SCOPE) && includesScope(options.scope, OFFLINE_SCOPE)
      ? Option.some(options.refresh)
      : Option.none(),
  scope: options.scope,
  token_type: TOKEN_TYPE,
})

const makeStore = (ttl: number = DEFAULT_TTL_SECONDS): TokenStore => {
  const codes = new Map<string, AuthorizationCode>()
  const accessTokens = new Map<string, { readonly scope: string }>()
  const refreshTokens = new Map<string, RefreshGrant>()
  const issue = (scope: string): Issued => {
    const access = `${ACCESS_PREFIX}${randomEncoded(TOKEN_BYTES)}`
    const refresh = `${REFRESH_PREFIX}${randomEncoded(TOKEN_BYTES)}`
    accessTokens.set(access, { scope })
    refreshTokens.set(refresh, { scope, spent: false })
    return issued({ access, refresh, scope, ttl })
  }
  return { accessTokens, codes, issue, refreshTokens }
}

const freshCode = (): string => randomEncoded(CODE_BYTES)

const grantSpent = (grant: Option.Option<RefreshGrant>): boolean => Option.isNone(grant) || grant.value.spent

const asJson = (tokens: Issued): Readonly<Record<string, string | number>> =>
  Option.match(tokens.refresh_token, {
    onNone: () => ({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      token_type: tokens.token_type,
    }),
    onSome: (refresh) => ({
      access_token: tokens.access_token,
      expires_in: tokens.expires_in,
      refresh_token: refresh,
      scope: tokens.scope,
      token_type: tokens.token_type,
    }),
  })

/**
 * Application module, not a public API.
 * @internal
 */
export { asJson, freshCode, grantSpent, makeStore }

/**
 * Application module, not a public API.
 * @internal
 */
export type { AuthorizationCode, RecordedRequests, TokenStore }
