/**
 * The site's pages, in navbar order: each Markdown file at the repository root
 * and the route it's served at. The Astro pages, the navbar, the consent
 * page's navbar, link rewriting (astro.config.ts), and the deploy's build
 * inputs (alchemy.run.ts) all come from this list.
 */
import { Array as Arr, Option, String as Str, pipe } from "effect"

const SITE_NAME = "Hardcover MCP"
const HOME = "/"
const LEADING_SLASH = /^\//v

/** One Markdown file served as a page. */
interface SitePage {
  readonly file: string
  readonly label: string
  readonly route: string
}

/** A navbar link. */
interface NavLink {
  readonly href: string
  readonly label: string
}

const PAGES: ReadonlyArray<SitePage> = [
  { file: "README.md", label: "Home", route: HOME },
  { file: "PRIVACY.md", label: "Privacy", route: "/privacy" },
  { file: "TERMS.md", label: "Terms", route: "/terms" },
  { file: "SECURITY.md", label: "Security", route: "/security" },
]

const SOURCE: NavLink = { href: "https://github.com/benjuntilla/hardcover-oauth-mcp", label: "Source" }

const NAV: ReadonlyArray<NavLink> = pipe(
  PAGES,
  Arr.map((page): NavLink => ({ href: page.route, label: page.label })),
  Arr.append(SOURCE),
)

/**
 * The page's document title.
 * @param {SitePage} page The page.
 * @returns {string} The title.
 */
const pageTitle = (page: SitePage): string => (page.route === HOME ? SITE_NAME : `${page.label} · ${SITE_NAME}`)

/**
 * The page's slug for Astro's `[...slug]` route: its route without the leading slash, or none for the home page.
 * @param {SitePage} page The page.
 * @returns {string | undefined} The slug.
 */
const pageSlug = (page: SitePage): string | undefined =>
  pipe(page.route.replace(LEADING_SLASH, ""), Option.liftPredicate(Str.isNonEmpty), Option.getOrUndefined)

/**
 * Application module, not a public API.
 * @internal
 */
export { NAV, PAGES, pageSlug, pageTitle }
/**
 * Application module, not a public API.
 * @internal
 */
export type { SitePage }
