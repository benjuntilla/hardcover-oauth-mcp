// The Markdown pages listed in site/routes.ts, prerendered to static
// Assets that the Worker serves ahead of its own routes. See alchemy.run.ts.
import { Array as Arr, Option, Record as Rec, pipe } from "effect"
import type { MdastVisitorContext } from "satteri"
import { PAGES } from "#root/site/routes.ts"
import Slugger from "github-slugger"
import { defineConfig } from "astro/config"
import { defineMdastPlugin } from "satteri"
import { satteri } from "@astrojs/markdown-satteri"

const SCHEME_START = /^[a-z]/iv
const HASH = "#"
const ROOT = "/"
/** Markdown files that are pages of the site (site/routes.ts), by file name. */
const PAGE_ROUTES: Readonly<Record<string, string>> = pipe(
  PAGES,
  Arr.map((page) => [page.file, page.route] as const),
  Rec.fromEntries,
)
const REPOSITORY_BLOB = "https://github.com/benjuntilla/hardcover-oauth-mcp/blob/main/"
const TOC_MARKER = "<!-- toc -->"
const TOC_DEPTH = 2

const hasScheme = (url: string): boolean => SCHEME_START.test(url) && url.includes(":")

/** Relative links in the Markdown work on GitHub; on the site, links to pages go to their routes and other files link to GitHub. */
const siteLinks = defineMdastPlugin({
  link(node, ctx: MdastVisitorContext): undefined {
    if (hasScheme(node.url) || node.url.startsWith(HASH) || node.url.startsWith(ROOT)) {
      return
    }
    const url = PAGE_ROUTES[node.url] ?? `${REPOSITORY_BLOB}${node.url}`
    ctx.setProperty(node, "url", url)
  },
  name: "site-links",
})

/**
 * Replaces a page's `<!-- toc -->` marker with links to its sections. GitHub hides the marker and shows its own
 * outline, so the Markdown needs no hand-kept contents list. Slugs come from the same slugger Astro uses for heading ids.
 */
const tableOfContents = defineMdastPlugin({
  before(root, ctx: MdastVisitorContext): undefined {
    const marker = Arr.findFirst(root.children, (node) => node.type === "html" && node.value.trim() === TOC_MARKER)
    if (Option.isNone(marker)) {
      return
    }
    const slugger = new Slugger()
    const items = pipe(
      root.children,
      Arr.flatMap((node) => (node.type === "heading" ? [{ depth: node.depth, text: ctx.textContent(node) }] : [])),
      Arr.map((heading) => ({ depth: heading.depth, slug: slugger.slug(heading.text), text: heading.text })),
      Arr.filter((heading) => heading.depth === TOC_DEPTH),
      Arr.map((heading) => ({
        children: [
          {
            children: [{ children: [{ type: "text", value: heading.text }], type: "link", url: `${HASH}${heading.slug}` }],
            type: "paragraph",
          },
        ],
        spread: false,
        type: "listItem",
      })),
    )
    ctx.replaceNode(marker.value, [
      { type: "html", value: '<nav class="toc" aria-label="Contents">' },
      { children: items, ordered: false, spread: false, type: "list" },
      { type: "html", value: "</nav>" },
    ])
  },
  name: "table-of-contents",
})

export default defineConfig({
  build: { format: "file" },
  markdown: { processor: satteri({ mdastPlugins: [tableOfContents, siteLinks] }), syntaxHighlight: false },
  outDir: "./dist/site",
  output: "static",
  publicDir: "./site/public",
  srcDir: "./site",
  trailingSlash: "never",
})
