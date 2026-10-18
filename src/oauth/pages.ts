/** Server-rendered pages: the consent screen and error/denied notices. */
import { Array as Arr, Option, pipe } from "effect"
import type { ConsentDescription } from "@cloudflare/workers-oauth-provider"
import { NAV } from "#root/site/routes.ts"
import type { Requirement } from "#src/hardcover/scopes.ts"
import { SCOPE_GROUPS } from "#src/hardcover/scopes.ts"

const OK = 200
const FOUND = 302
const HTML_CONTENT = "text/html; charset=utf-8"
const NO_STORE = "no-store"
const FRAME_POLICY = "default-src 'none'; style-src 'self'; frame-ancestors 'none'"
/** The characters escaped in HTML text and attributes, as numeric character references. */
const ESCAPES: Readonly<Record<string, string>> = {
  '"': "&#34;",
  "&": "&#38;",
  "'": "&#39;",
  "<": "&#60;",
  ">": "&#62;",
}
const ESCAPED = /[&<>"']/gv

/**
 * Escapes text for HTML. Everything from the client (name, scopes, URIs) goes through this.
 * @param {string} value The untrusted text.
 * @returns {string} The escaped text.
 */
const escapeHtml = (value: string): string => value.replaceAll(ESCAPED, (char) => ESCAPES[char] ?? char)

/** The static pages' navbar (site/routes.ts), with no page marked current. */
const NAV_HTML = pipe(
  NAV,
  Arr.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`),
  Arr.join(""),
)

const REQUIREMENT_LABEL: Readonly<Record<Requirement, string>> = {
  librarian: "Librarian",
  "librarian:book_mapper": "Librarian: book mapper",
  supporter: "Supporter",
}

/**
 * The page chrome, with the static pages' navbar (site/layouts/page.astro), styled by `/site.css`.
 * @param {string} title The page title.
 * @param {string} body The page body, already escaped where it came from the client.
 * @returns {string} The document.
 */
const page = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/site.css"></head>
<body><header><nav>${NAV_HTML}</nav></header>
<main>${body}</main>
</body></html>`

/**
 * One scope's row on the consent form.
 * @param {Readonly<{ label: string; required: boolean; requires?: Requirement; scope: string }>} info The scope.
 * @param {ReadonlySet<string>} checked The scopes to pre-tick.
 * @returns {string} The row.
 */
const scopeRow = (info: (typeof SCOPE_GROUPS)[number]["scopes"][number], checked: ReadonlySet<string>): string => {
  const tag = Option.match(Option.fromNullishOr(info.requires), {
    onNone: () => "",
    onSome: (requires) => `<span class="tag">${escapeHtml(REQUIREMENT_LABEL[requires])}</span>`,
  })
  const isChecked = info.required === true || checked.has(info.scope) ? " checked" : ""
  const disabled = info.required === true ? " disabled" : ""
  const hidden = info.required === true ? `<input type="hidden" name="scope" value="${escapeHtml(info.scope)}">` : ""
  return `<label><input type="checkbox" name="scope" value="${escapeHtml(info.scope)}"${isChecked}${disabled}>${hidden}<span>${escapeHtml(info.label)}${tag}<br><code>${escapeHtml(info.scope)}</code></span></label>`
}

/**
 * One group of scopes.
 * @param {(typeof SCOPE_GROUPS)[number]} group The group.
 * @param {ReadonlySet<string>} checked The scopes to pre-tick.
 * @returns {string} The fieldset.
 */
const scopeGroup = (group: (typeof SCOPE_GROUPS)[number], checked: ReadonlySet<string>): string => {
  const rows = pipe(
    group.scopes,
    Arr.map((info) => scopeRow(info, checked)),
    Arr.join(""),
  )
  const note = Option.match(Option.fromNullishOr(group.note), {
    onNone: () => "",
    onSome: (text) => (text === "" ? "" : `<p class="muted">${escapeHtml(text)}</p>`),
  })
  return `<fieldset><legend>${escapeHtml(group.title)}</legend>${note}${rows}</fieldset>`
}

/**
 * The consent screen.
 * @param {object} options The consent request.
 * @param {ConsentDescription} options.details What the client is asking for.
 * @param {string} options.handle The consent handle to post back.
 * @param {ReadonlySet<string>} options.checked The scopes to pre-tick.
 * @returns {string} The page.
 */
const consentPage = (options: {
  readonly details: ConsentDescription
  readonly handle: string
  readonly checked: ReadonlySet<string>
}): string => {
  const name = escapeHtml(options.details.clientName)
  const domain = Option.fromNullishOr(options.details.clientDomain)
  const origin = Option.match(domain, {
    onNone: () => "This app registered itself, so its name is not verified.",
    onSome: (value) =>
      value === "" ? "This app registered itself, so its name is not verified." : `Published by <strong>${escapeHtml(value)}</strong>.`,
  })
  const loopback = options.details.redirectIsLoopback
    ? `<p class="warn">This sends access to an app on your own computer. Continue only if you just started connecting from it.</p>`
    : ""
  const groups = pipe(
    SCOPE_GROUPS,
    Arr.map((group) => scopeGroup(group, options.checked)),
    Arr.join(""),
  )
  return page(
    `Connect ${options.details.clientName} to Hardcover`,
    `<h1>Allow ${name} to use your Hardcover account?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(options.details.redirectHost)}</strong>.</p>${loopback}
<p class="muted">Next you'll sign in to Hardcover and approve the same permissions there. You can revoke access any time under Hardcover → Account → API → Authorized apps. <a href="/privacy">What this server stores</a>.</p>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(options.handle)}">
${groups}
<div class="actions"><button class="primary" name="decision" value="approve">Continue to Hardcover</button><button name="decision" value="deny">Deny</button></div>
</form>`,
  )
}

/**
 * A notice page: a denial, a failure, or a private server.
 * @param {object} options The notice.
 * @param {string} options.title The heading.
 * @param {string} options.message The message.
 * @param {string} options.detail Extra detail, when there is some.
 * @returns {string} The page.
 */
const messagePage = (options: { readonly title: string; readonly message: string; readonly detail?: string }): string =>
  page(
    options.title,
    `<h1>${escapeHtml(options.title)}</h1><p>${escapeHtml(options.message)}</p>${Option.match(Option.fromNullishOr(options.detail), { onNone: () => "", onSome: (detail) => (detail === "" ? "" : `<p class="muted">${escapeHtml(detail)}</p>`) })}`,
  )

/**
 * An HTML response with the page's security headers.
 * @param {object} options The response.
 * @param {string} options.body The document.
 * @param {number} options.status The HTTP status, 200 when omitted.
 * @param {Headers} options.headers Extra headers, such as the consent cookie.
 * @returns {Response} The response.
 */
const html = (options: { readonly body: string; readonly status?: number; readonly headers?: Headers }): Response => {
  const out = new Headers(options.headers)
  out.set("content-type", HTML_CONTENT)
  out.set("cache-control", NO_STORE)
  out.set("content-security-policy", FRAME_POLICY)
  out.set("x-frame-options", "DENY")
  return new Response(options.body, { headers: out, status: options.status ?? OK })
}

/**
 * A redirect that isn't cached.
 * @param {object} options The redirect.
 * @param {string} options.location Where to send the browser.
 * @param {Headers} options.headers Headers to send along, such as the consent cookie; the redirect's own are added to them.
 * @returns {Response} The redirect.
 */
const redirect = (options: { readonly location: string; readonly headers?: Headers }): Response => {
  const headers = options.headers ?? new Headers()
  headers.set("location", options.location)
  headers.set("cache-control", NO_STORE)
  return new Response(Option.getOrNull(Option.none()), { headers, status: FOUND })
}

/**
 * Application module, not a public API.
 * @internal
 */
export { consentPage, html, messagePage, redirect }
