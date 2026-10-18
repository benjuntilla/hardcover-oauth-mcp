// Unused files, exports, and dependencies.
import type { KnipConfig } from "knip"

const config: KnipConfig = {
  entry: ["src/worker.ts", "alchemy.run.ts", "test/e2e.run.ts", "scripts/*.ts", "test/**/*.test.ts"],
  // `bun check` is Bun's built-in type checker (Bun 1.4.3); knip reads it as a missing `check` binary.
  ignoreBinaries: ["check"],
  ignoreDependencies: ["@effect/language-service", "cloudflare"],
  project: ["*.ts", "src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts", "site/**/*.{astro,ts}"],
}

export default config
