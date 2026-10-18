/**
 * The interactive half of the MCP authorization server: `/authorize` shows our
 * consent page, then hands the browser to Hardcover; `/callback` exchanges
 * Hardcover's code, records the tokens in a `HardcoverConnection`, and
 * completes the MCP client's authorization. Protocol endpoints (metadata,
 * token, registration) are served by `OAuthProvider` itself.
 */
import { Cause, Effect } from "effect"
import { showConsent, submitConsent } from "#src/oauth/consent.ts"
import type { AuthorizeRequest } from "#src/oauth/consent.ts"
import type { Env } from "#src/env.ts"
import { callback } from "#src/oauth/callback.ts"
import { failurePage } from "#src/oauth/failures.ts"
import { platform } from "#src/platform.ts"
import { publicOrigin } from "#src/oauth/origin.ts"

const NOT_FOUND = 404

/**
 * The handler for one path and method.
 * @param {URL} url The request URL.
 * @param {AuthorizeRequest} request The request.
 * @returns {Effect.Effect} The response.
 */
const route = (url: URL, request: AuthorizeRequest): ReturnType<typeof callback> => {
  const { method } = request.req
  if (url.pathname === "/authorize" && method === "GET") {
    return showConsent(request)
  }
  if (url.pathname === "/authorize" && method === "POST") {
    return submitConsent(request)
  }
  if (url.pathname === "/callback" && method === "GET") {
    return callback(request)
  }
  return Effect.succeed(new Response("Not found", { status: NOT_FOUND }))
}

/**
 * The handler `OAuthProvider` calls for everything that isn't a protocol endpoint.
 */
const defaultHandler = {
  /**
   * Serves `/authorize` and `/callback`.
   * @param {Request} req The request.
   * @param {Env} env The Worker bindings, with `OAUTH_PROVIDER`.
   * @returns {Promise<Response>} The response.
   */
  fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    const origin = publicOrigin({ env, url })
    return platform.runPromise(route(url, { env, origin, req }).pipe(Effect.catchCause((cause) => failurePage(Cause.squash(cause)))))
  },
}

/**
 * Application module, not a public API.
 * @internal
 */
export { defaultHandler }
