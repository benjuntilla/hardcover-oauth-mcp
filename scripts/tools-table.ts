/**
 * Rewrites the README's tool reference from the toolkit itself:
 *   mise run docs:tools
 */
import { Effect, String as Str } from "effect"
import { readText, writeText } from "#root/scripts/script-io.ts"
import { toolsTable } from "#src/docs/tools-table.ts"

const START_MARK = "<!-- tools:start"
const END_MARK = "<!-- tools:end -->"
const UP_TO_DATE = "README tool table is up to date"
const UPDATED = "Updated the README tool table"
const TOOLS_REGION = new RegExp(String.raw`(?<start>${START_MARK}[^>]*-->\n)[\s\S]*?(?<end>\n${END_MARK})`, "v")

const readmeUrl = new URL("../README.md", import.meta.url)

const rewrite = (readme: string): string => Str.replace(TOOLS_REGION, `$<start>${toolsTable()}$<end>`)(readme)

const updateReadme = Effect.gen(function* updateReadme() {
  const readme = yield* readText(readmeUrl)
  const updated = rewrite(readme)
  if (updated !== readme) {
    yield* writeText({ text: updated, url: readmeUrl })
  }
  yield* Effect.logInfo(updated === readme ? UP_TO_DATE : UPDATED)
})

if (import.meta.main) {
  Effect.runFork(updateReadme)
}
