/**
 * The public origin tokens are issued for.
 */
import type { Env } from "#src/env.ts"

/**
 * `PUBLIC_URL` (the custom domain's URL) when set, else the request's own origin.
 * @param {object} options The deployment and the request.
 * @param {Env} options.env The Worker bindings.
 * @param {URL} options.url The request URL.
 * @returns {string} The origin.
 */
const publicOrigin = (options: { readonly env: Env; readonly url: URL }): string =>
  options.env.PUBLIC_URL === "" ? options.url.origin : new URL(options.env.PUBLIC_URL).origin

/**
 * Application module, not a public API.
 * @internal
 */
export { publicOrigin }
