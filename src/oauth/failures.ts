/**
 * The pages for sign-in steps that fail in expected ways: the OAuth library
 * refusing a request, and Hardcover refusing the sign-in. Anything else stays a
 * failure of the request.
 */
import { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider"
import { Effect, Option, Schema, String as Str, pipe } from "effect"
import { html, messagePage, redirect } from "#src/oauth/pages.ts"
import { HardcoverOAuthError } from "#src/hardcover/oauth-types.ts"

const BAD_REQUEST = 400
const BAD_GATEWAY = 502
const START_AGAIN = "Start connecting again from your MCP client."

/**
 * The response for a failed sign-in step.
 * @param {unknown} error What the step failed with.
 * @returns {Effect.Effect<Response>} The page or redirect; other errors are defects.
 */
const failurePage = (error: unknown): Effect.Effect<Response> => {
  if (error instanceof AuthorizationError) {
    const location = pipe(Option.fromNullishOr(error.redirectTo), Option.filter(Str.isNonEmpty))
    return Effect.succeed(
      Option.match(location, {
        onNone: () =>
          html({ body: messagePage({ detail: START_AGAIN, message: error.description, title: "Can't continue" }), status: BAD_REQUEST }),
        onSome: (to) => redirect({ location: to }),
      }),
    )
  }
  if (error instanceof CimdFetchError) {
    return Effect.succeed(
      html({
        body: messagePage({ message: "Its client metadata document could not be fetched.", title: "Can't verify this app" }),
        status: BAD_REQUEST,
      }),
    )
  }
  if (Schema.is(HardcoverOAuthError)(error)) {
    const page = html({
      body: messagePage({ detail: START_AGAIN, message: error.description, title: "Hardcover sign-in failed" }),
      status: BAD_GATEWAY,
    })
    const report = error.code === "invalid_response" ? Effect.logError("[hardcover-oauth-mcp] defect: sign-in failed:", error) : Effect.void
    return Effect.as(report, page)
  }
  return Effect.die(error)
}

/**
 * Application module, not a public API.
 * @internal
 */
export { failurePage }
