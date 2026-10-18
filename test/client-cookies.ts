/**
 * Cookie jar for the scripted consent walk. A `Set-Cookie` with `max-age=0`
 * or an empty value deletes the cookie, matching the browser; the `Cookie`
 * header sends each value exactly as the server set it.
 */
import { Duration, Predicate, Record as Rec, String as Str } from "effect"
import { Cookies } from "effect/http"
import type { HttpClientResponse } from "effect/http"

const ZERO_SECONDS = 0

type Jar = Cookies.Cookies

const emptyJar: Jar = Cookies.empty

const live = (cookie: Cookies.Cookie): boolean => {
  const age = cookie.options?.maxAge
  const expired = Predicate.isNotUndefined(age) && Duration.toSeconds(age) === ZERO_SECONDS
  return !expired && Str.isNonEmpty(cookie.valueEncoded)
}

const newer = (_stored: Cookies.Cookie, received: Cookies.Cookie): Cookies.Cookie => received

/**
 * Applies a response's `Set-Cookie` headers to the jar: received cookies
 * replace stored ones of the same name, and expired or emptied ones go.
 * @param {object} options The jar and the response.
 * @param {Jar} options.jar The cookies so far.
 * @param {HttpClientResponse.HttpClientResponse} options.response The response that may set or clear cookies.
 * @returns {Jar} The updated cookies.
 */
const absorb = (options: { readonly jar: Jar; readonly response: HttpClientResponse.HttpClientResponse }): Jar =>
  Cookies.fromReadonlyRecord(Rec.filter(Rec.union(options.jar.cookies, options.response.cookies.cookies, newer), live))

const cookieHeader = (jar: Jar): string => Cookies.toCookieHeader(jar)

/**
 * Application module, not a public API.
 * @internal
 */
export { absorb, cookieHeader, emptyJar }

/**
 * Application module, not a public API.
 * @internal
 */
export type { Jar }
