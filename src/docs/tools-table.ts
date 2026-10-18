/** The README's tool reference, generated from the toolkit so it can't drift (checked by test/unit.test.ts). */
import { Array as Arr, Context, Option, Predicate, Record as Rec, String as Str, pipe } from "effect"
import { HardcoverToolkit } from "#src/mcp/toolkit.ts"
import { Tool } from "effect/ai"
import type { ToolPolicy } from "#src/mcp/define.ts"
import { toolPolicy } from "#src/mcp/define.ts"

const REQUIRES: Readonly<Record<string, string>> = {
  librarian: "Librarian",
  "librarian:book_mapper": "Librarian (book_mapper)",
  supporter: "Supporter",
}
const KIND: Readonly<Record<string, string>> = { create: "write", delete: "delete", read: "read", update: "write" }
const CATALOG_PREFIX = "write:catalog"
const REQUIREMENT_ENTRY = 1
const TITLE_SUFFIX = / \((?<who>Supporter|Librarian).*\)$/v
const NONE = "none"

const requirementLabel = (requirement: string): string => REQUIRES[requirement] ?? requirement

const anyOfCell = (policy: ToolPolicy): ReadonlyArray<string> =>
  pipe(
    policy.anyOf,
    Option.filter(Arr.isReadonlyArrayNonEmpty),
    Option.match({
      onNone: () => [],
      onSome: (scopes) => {
        const catalog = pipe(scopes, Arr.every(Str.startsWith(CATALOG_PREFIX))) ? " catalog" : ""
        return [`any \`write:*\`${catalog} scope`]
      },
    }),
  )

const scopeCells = (policy: ToolPolicy): ReadonlyArray<string> =>
  pipe(
    policy.scopes,
    Arr.map((scope) => `\`${scope}\``),
    Arr.appendAll(anyOfCell(policy)),
  )

const extraNeeds = (policy: ToolPolicy): ReadonlyArray<string> =>
  pipe(
    policy.scopeRequires,
    Option.getOrElse(() => ({})),
    Rec.toEntries,
    Arr.filter((entry) => !pipe(policy.requires, Arr.contains(entry[REQUIREMENT_ENTRY]))),
    Arr.map(([scope, requirement]) => `${requirementLabel(requirement)} for \`${scope}\``),
  )

const needCells = (policy: ToolPolicy): ReadonlyArray<string> =>
  pipe(policy.requires, Arr.map(requirementLabel), Arr.appendAll(extraNeeds(policy)))

const annotationTitle = (annotations: Context.Context<never>): unknown => Context.getOption(annotations, Tool.Title)

const titled = (name: unknown, annotations: Context.Context<never>): string => {
  const fallback = Predicate.isString(name) ? name : ""
  const found: unknown = annotationTitle(annotations)
  if (!Option.isOption(found)) {
    return fallback
  }
  const title = Option.isSome(found) && Predicate.isString(found.value) ? found.value : fallback
  return pipe(title, Str.replace(TITLE_SUFFIX, ""))
}

const rowFor = (tool: Tool.Any): string => {
  const policy = Option.getOrThrow(toolPolicy(tool))
  const scopes = scopeCells(policy)
  const scopeText = Arr.isReadonlyArrayNonEmpty(scopes) ? pipe(scopes, Arr.join(", ")) : NONE
  return `| \`${tool.name}\` | ${titled(tool.name, tool.annotations)} | ${KIND[policy.kind]} | ${scopeText} | ${pipe(needCells(policy), Arr.join(", "))} |`
}

const toolsTable = (): string => {
  const rows = pipe(
    HardcoverToolkit.tools,
    Rec.values,
    Arr.map((tool) => rowFor(tool)),
  )
  // Collapsed by default on GitHub and the landing page; the blank lines let Markdown parse the table inside the HTML.
  return pipe(
    [
      "<details>",
      `<summary>All ${rows.length} tools</summary>`,
      "",
      "| Tool | What it does | Kind | Scopes | Needs |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
      "",
      "</details>",
    ],
    Arr.join("\n"),
  )
}

export { toolsTable }
