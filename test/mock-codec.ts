/**
 * URL-safe encoding and PKCE digests for the mock Hardcover server. Uses the
 * platform Web Crypto API, which is the Effect-allowed replacement for
 * `node:crypto` at this boundary.
 */
import { Array as Arr, Effect, pipe } from "effect"

const DIGEST = "SHA-256"
const PLUS = "+"
const SLASH = "/"
const DASH = "-"
const UNDERSCORE = "_"
const PADDING = "="
const EMPTY = ""

const binary = (bytes: Uint8Array): string => {
  const characters: Array<string> = []
  for (const byte of bytes) {
    characters.push(String.fromCodePoint(byte))
  }
  return pipe(characters, Arr.join(EMPTY))
}

const encoded = (bytes: Uint8Array): string =>
  btoa(binary(bytes)).replaceAll(PLUS, DASH).replaceAll(SLASH, UNDERSCORE).replaceAll(PADDING, EMPTY)

const randomBytes = (size: number): Uint8Array => crypto.getRandomValues(new Uint8Array(size))

const randomEncoded = (size: number): string => encoded(randomBytes(size))

const digest = (value: string): Effect.Effect<string> =>
  Effect.promise(() => crypto.subtle.digest(DIGEST, new TextEncoder().encode(value))).pipe(
    Effect.map((buffer) => encoded(new Uint8Array(buffer))),
  )

/**
 * Application module, not a public API.
 * @internal
 */
export { digest, randomEncoded }
