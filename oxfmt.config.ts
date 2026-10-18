// Formatting: oxfmt's Prettier-compatible defaults with wider lines and no semicolons.
import { defineConfig } from "oxfmt"

export default defineConfig({
  arrowParens: "always",
  ignorePatterns: ["*.md", "src/generated/**", "test/fixtures/**", "bun.lock"],
  printWidth: 140,
  semi: false,
  trailingComma: "all",
})
