/**
 * What Hardcover's HTTP answer means: the `data` of a 200, or a `HardcoverError` with advice.
 */
import { Array as Arr, Effect, Option, Predicate, Schema, Struct, pipe } from "effect"
import type { HardcoverAnswer } from "#src/hardcover/transport.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"

const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_TIMEOUT = 408
const HTTP_TOO_MANY = 429
const SECONDS_PER_HOUR = 3600
const MAY_HAVE_APPLIED = "The change may or may not have been applied; check before retrying."

/** The fields Hardcover's answers use, whatever else the body holds. */
const AnswerBody = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
  error_description: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(Schema.Unknown),
  message: Schema.optionalKey(Schema.Unknown),
  scope: Schema.optionalKey(Schema.Unknown),
})

type AnswerFields = typeof AnswerBody.Type

/** One answer, read. */
interface Reading {
  readonly fields: AnswerFields
  /** The `error` code Hardcover named, if any. */
  readonly error: Option.Option<string>
  /** `error_description`, else `message`, else empty. */
  readonly description: string
  readonly mutation: boolean
  readonly status: number
  /** Seconds until a retry may succeed, from the rate-limit headers. */
  readonly wait: Option.Option<number>
  /** Whether the daily rate limit is the one that ran out. */
  readonly daily: boolean
}

/**
 * A failed call with advice.
 * @param {HardcoverError["kind"]} kind Which kind of failure it is.
 * @param {string} message What to tell the model.
 * @returns {Effect.Effect<never, HardcoverError>} The failure.
 */
const fail = (kind: HardcoverError["kind"], message: string): Effect.Effect<never, HardcoverError> =>
  Effect.fail(HardcoverError.make({ kind, message }))

/**
 * A string, or none.
 * @param {unknown} value Any value.
 * @returns {Option.Option<string>} The string.
 */
const text = (value: unknown): Option.Option<string> => (Predicate.isString(value) ? Option.some(value) : Option.none())

/**
 * One property of a value, when the value is an object that has it.
 * @param {unknown} value Any value.
 * @param {string} key The property name.
 * @returns {Option.Option<unknown>} The property, or none.
 */
const property = (value: unknown, key: string): Option.Option<unknown> =>
  Predicate.hasProperty(value, key) ? Option.some(value[key]) : Option.none()

/**
 * One GraphQL error as text, with its code and path when Hardcover sent them.
 * @param {unknown} error One entry of the `errors` array.
 * @returns {string} The description.
 */
const describeError = (error: unknown): string => {
  if (Predicate.isString(error)) {
    return error
  }
  const extensions = property(error, "extensions")
  const field = (key: string): Option.Option<string> =>
    pipe(
      extensions,
      Option.flatMap((value) => property(value, key)),
      Option.flatMap(text),
    )
  const code = Option.match(field("code"), { onNone: () => "", onSome: (value) => ` [${value}]` })
  const path = Option.match(field("path"), { onNone: () => "", onSome: (value) => ` at ${value}` })
  const message = Option.getOrElse(Option.flatMap(property(error, "message"), text), () => JSON.stringify(error))
  return `${message}${code}${path}`
}

/**
 * The `data` of a 200, unless Hardcover rejected the document.
 * @param {AnswerFields} fields The answer's fields.
 * @param {string} operation The operation name, for the defect report.
 * @returns {Effect.Effect<unknown, HardcoverError>} The `data` object.
 */
const succeeded = (fields: AnswerFields, operation: string): Effect.Effect<unknown, HardcoverError> => {
  const errors = Arr.isArray(fields.errors) ? fields.errors : []
  if (Arr.isReadonlyArrayNonEmpty(errors)) {
    return fail("invalid", `Hardcover rejected the request: ${pipe(errors, Arr.map(describeError), Arr.join("; "))}`)
  }
  // A 200 without data means Hardcover's API no longer behaves as this server expects.
  return Predicate.isObjectOrArray(fields.data)
    ? Effect.succeed(fields.data)
    : Effect.die(new Error(`Hardcover answered ${operation} with HTTP 200 but no data`))
}

/**
 * What a 403 means, which depends on the error Hardcover named.
 * @param {Reading} reading The answer.
 * @returns {Effect.Effect<never, HardcoverError>} The failure.
 */
const forbidden = (reading: Reading): Effect.Effect<never, HardcoverError> => {
  const error = Option.getOrElse(reading.error, () => "")
  if (error === "insufficient_scope") {
    const scope = Option.getOrElse(text(reading.fields.scope), () => reading.description)
    return fail(
      "forbidden",
      `Hardcover refused: missing permission ${scope}. If that is a librarian scope, your account needs the librarian ` +
        `role; otherwise reconnect the MCP server and grant it.`,
    )
  }
  if (error === "unsupported_operation") {
    return fail("forbidden", `Hardcover does not allow this operation for API tokens. ${reading.description}`.trim())
  }
  if (Arr.isArray(reading.fields.errors) && Arr.contains(reading.fields.errors, "request_exceeds_capacity")) {
    return fail("invalid", "Too many top-level fields in one request for your Hardcover rate-limit burst. Split it into smaller requests.")
  }
  return fail("forbidden", `Hardcover refused the request: ${Option.getOrElse(reading.error, () => reading.description)}`)
}

/**
 * What a 429 means, including when the daily limit is the one that ran out.
 * @param {Reading} reading The answer.
 * @returns {Effect.Effect<never, HardcoverError>} The failure, with the wait when Hardcover gave one.
 */
const rateLimited = (reading: Reading): Effect.Effect<never, HardcoverError> => {
  const after = (format: (seconds: number) => string): string => Option.match(reading.wait, { onNone: () => "", onSome: format })
  const message = reading.daily
    ? `Hardcover's daily API limit for this account is used up${after((seconds) => `; it resets in about ${Math.ceil(seconds / SECONDS_PER_HOUR)} hour(s)`)}.`
    : `Hardcover rate limit reached${after((seconds) => `; retry in ${seconds} seconds`)}.`
  const fields = { kind: "rate_limited" as const, message }
  return Effect.fail(
    HardcoverError.make(
      Option.match(reading.wait, { onNone: () => fields, onSome: (seconds) => Struct.assign(fields, { retryAfterSeconds: seconds }) }),
    ),
  )
}

/**
 * What an answer other than a 200 means.
 * @param {Reading} reading The answer.
 * @returns {Effect.Effect<never, HardcoverError>} The failure.
 */
const refused = (reading: Reading): Effect.Effect<never, HardcoverError> => {
  switch (reading.status) {
    case HTTP_BAD_REQUEST: {
      const detail = reading.description === "" ? Option.getOrElse(reading.error, () => "") : reading.description
      return fail("invalid", `Hardcover could not parse the request: ${detail === "" ? "malformed query" : detail}`)
    }
    case HTTP_UNAUTHORIZED: {
      return fail("reauth", "Hardcover no longer accepts this connection. Reconnect the MCP server to sign in again.")
    }
    case HTTP_FORBIDDEN: {
      return forbidden(reading)
    }
    case HTTP_NOT_FOUND: {
      return fail("not_found", "Hardcover returned 404 Not Found.")
    }
    case HTTP_TIMEOUT: {
      return fail(
        "timeout",
        reading.mutation
          ? `Hardcover timed out. ${MAY_HAVE_APPLIED}`
          : "The query took longer than Hardcover's 30 second limit. Ask for fewer rows or fields.",
      )
    }
    case HTTP_TOO_MANY: {
      return rateLimited(reading)
    }
    default: {
      return fail("unavailable", `Hardcover returned HTTP ${reading.status}. ${reading.mutation ? MAY_HAVE_APPLIED : "Try again shortly."}`)
    }
  }
}

/**
 * Turns Hardcover's answer into the `data` object, or a `HardcoverError`.
 * @param {object} options The answer and what the caller knows about it.
 * @param {HardcoverAnswer} options.answer The status, headers, and body.
 * @param {boolean} options.mutation Whether the operation changes data.
 * @param {string} options.operation The operation name, for defect reports.
 * @param {Option.Option<number>} options.wait Seconds until a retry may succeed, from the rate-limit headers.
 * @param {boolean} options.daily Whether the daily rate limit ran out.
 * @returns {Effect.Effect<unknown, HardcoverError>} The `data` object.
 */
const interpret = (options: {
  readonly answer: HardcoverAnswer
  readonly daily: boolean
  readonly mutation: boolean
  readonly operation: string
  readonly wait: Option.Option<number>
}): Effect.Effect<unknown, HardcoverError> => {
  const fields = pipe(
    options.answer.body,
    Option.flatMap(Schema.decodeUnknownOption(AnswerBody)),
    Option.getOrElse((): AnswerFields => ({})),
  )
  if (options.answer.status === HTTP_OK) {
    return succeeded(fields, options.operation)
  }
  const description = Option.getOrElse(
    Option.orElse(text(fields.error_description), () => text(fields.message)),
    () => "",
  )
  return refused({
    daily: options.daily,
    description,
    error: text(fields.error),
    fields,
    mutation: options.mutation,
    status: options.answer.status,
    wait: options.wait,
  })
}

/**
 * Application module, not a public API.
 * @internal
 */
export { interpret }
