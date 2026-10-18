/**
 * Small response builders for the mock. Status numbers live here so route
 * handlers do not repeat them.
 */
import { Effect, Option, Record as Rec } from "effect"

const BAD_REQUEST = 400
const EMPTY_LENGTH = 0
const NOT_FOUND = 404
const OK = 200
const REDIRECT = 302
const UNAUTHORIZED = 401

const json = (options: Readonly<{ body: unknown; status: number }>): Response => Response.json(options.body, { status: options.status })

const text = (options: Readonly<{ body: string; status: number }>): Response => new Response(options.body, { status: options.status })

// An empty 200, like `new Response(null)`: no body and no content type.
const empty = (): Response => new Response(new Uint8Array(EMPTY_LENGTH), { status: OK })

const redirect = (location: URL): Response => Response.redirect(location.toString(), REDIRECT)

const parameter = (options: Readonly<{ name: string; url: URL }>): Option.Option<string> =>
  Option.fromNullishOr(options.url.searchParams.get(options.name))

const parameterOrEmpty = (options: Readonly<{ name: string; url: URL }>): string => Option.getOrElse(parameter(options), () => "")

const formFields = (request: Request): Effect.Effect<Record<string, string>> =>
  Effect.promise(() => request.text()).pipe(Effect.map((body) => Rec.fromEntries(new URLSearchParams(body))))

const present = (value: string): boolean => value.length > EMPTY_LENGTH

/**
 * Application module, not a public API.
 * @internal
 */
export { BAD_REQUEST, NOT_FOUND, OK, UNAUTHORIZED, empty, formFields, json, parameterOrEmpty, present, redirect, text }
