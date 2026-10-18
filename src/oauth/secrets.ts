/**
 * Keys derived from the Hardcover client secret, so a deployment needs no
 * extra secrets. Rotating the client secret invalidates remembered consent.
 */
import { Array as Arr, Effect, Option, Schema, pipe } from "effect"

const HKDF_BYTES = 32
const BITS_PER_BYTE = 8
const HEX_RADIX = 16
const HEX_WIDTH = 2
const HKDF_SALT = "hardcover-oauth-mcp"
const CONSENT_INFO = "consent-cookie v1"
const GRANT_USER_INFO = "grant-user-id v1"
const GRANT_USER_BYTES = 16

const encoder = new TextEncoder()

class KeyDerivationError extends Schema.TaggedError<KeyDerivationError, { readonly brand: unique symbol }>()("KeyDerivationError", {
  cause: Schema.Unknown,
}) {}

/**
 * WebCrypto rejecting a key derivation.
 * @param {unknown} cause What WebCrypto threw.
 * @returns {KeyDerivationError} The typed error.
 */
const derivationFailed = (cause: unknown): KeyDerivationError => KeyDerivationError.make({ cause })

/**
 * HKDF-SHA256 of `secret`, as lowercase hex.
 * @param {string} secret The input keying material.
 * @param {string} info The derivation context.
 * @param {number} bytes How many bytes to derive.
 * @returns {Promise<string>} The derived key as hex.
 */
const hkdf = (secret: string, info: string, bytes: number = HKDF_BYTES): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* deriveConsentKey() {
      const key = yield* Effect.tryPromise({
        catch: derivationFailed,
        try: () => crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveBits"]),
      })
      const bits = yield* Effect.tryPromise({
        catch: derivationFailed,
        try: () =>
          crypto.subtle.deriveBits(
            { hash: "SHA-256", info: encoder.encode(info), name: "HKDF", salt: encoder.encode(HKDF_SALT) },
            key,
            bytes * BITS_PER_BYTE,
          ),
      })
      return pipe(
        [...new Uint8Array(bits)],
        Arr.map((byte) => byte.toString(HEX_RADIX).padStart(HEX_WIDTH, "0")),
        Arr.join(""),
      )
    }),
  )

const consentSecrets = new Map<string, Promise<string>>()

/**
 * HMAC key for the remembered-consent cookie (64 hex chars).
 * @param {string} clientSecret The Hardcover client secret.
 * @returns {Promise<string>} The cookie secret, cached per isolate for that client secret.
 */
const consentCookieSecret = (clientSecret: string): Promise<string> => {
  const cached = Option.fromNullishOr(consentSecrets.get(clientSecret))
  if (Option.isSome(cached)) {
    return cached.value
  }
  const value = hkdf(clientSecret, CONSENT_INFO)
  consentSecrets.set(clientSecret, value)
  return value
}

/**
 * The user id the OAuth provider files a grant under: a keyed pseudonym of the Hardcover user id (32 hex chars).
 * The provider puts it in KV keys, which traces record, and in the client's tokens. It is stable, so the provider
 * still replaces an account's earlier grant to the same client.
 * @param {object} options The account.
 * @param {string} options.clientSecret The Hardcover client secret.
 * @param {number} options.hcUserId The Hardcover user id.
 * @returns {Promise<string>} The pseudonym.
 */
const grantUserId = (options: { readonly clientSecret: string; readonly hcUserId: number }): Promise<string> =>
  hkdf(options.clientSecret, `${GRANT_USER_INFO}:${options.hcUserId}`, GRANT_USER_BYTES)

/**
 * Application module, not a public API.
 * @internal
 */
export { consentCookieSecret, grantUserId }
