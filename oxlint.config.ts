// Lint rules: every oxlint category plus the Effect rules (effecttsgo), type-aware, with the exceptions below.
import { Array as Arr, Record as Rec, pipe } from "effect"
import { defineConfig } from "oxlint"

/** Platform types whose typings are mutable but which the code treats as values. */
const PLATFORM_TYPES = [
  "Buffer",
  "DurableObjectState",
  "DurableObjectStorage",
  "ExecutionContext",
  "Headers",
  "Request",
  "RequestInit",
  "Response",
  "URL",
  "Uint8Array",
]

/** Packages that declare the platform types, besides TypeScript's own lib. */
const PLATFORM_PACKAGES = ["@cloudflare/workers-types", "@types/node", "bun-types", "undici-types"]

/** Library types `prefer-readonly-parameter-types` accepts as parameters, by package. */
const READONLY_ENOUGH: Readonly<Record<string, ReadonlyArray<string>>> = {
  "@cloudflare/workers-oauth-provider": [
    "AuthRequest",
    "ClientInfo",
    "CompleteAuthorizationOptions",
    "ConsentDescription",
    "Grant",
    "OAuthHelpers",
    "OAuthResourceContext",
    "TokenExchangeCallbackOptions",
  ],
  "@types/mdast": ["Link"],
  effect: [
    "Any",
    "Cookie",
    "Cookies",
    "GraphQLClientError",
    "HttpBody",
    "HttpClientRequest",
    "HttpClientResponse",
    "None",
    "Operation",
    "Option",
    "Some",
    "Tool",
    "Toolkit",
  ],
  "effect/ai": ["Any", "Tool", "Toolkit"],
  "effect/http": ["Headers", "HttpClient", "HttpClientRequest", "HttpClientResponse"],
  graphql: [
    "ASTNode",
    "DocumentNode",
    "FieldNode",
    "FragmentDefinitionNode",
    "GraphQLField",
    "GraphQLInputField",
    "GraphQLInputType",
    "GraphQLNamedType",
    "GraphQLOutputType",
    "GraphQLSchema",
    "GraphQLType",
    "OperationDefinitionNode",
    "SelectionNode",
    "SelectionSetNode",
  ],
  mdast: ["Link"],
  satteri: ["MdastVisitorContext"],
}

const readonlyEnough = [
  { from: "lib" as const, name: PLATFORM_TYPES },
  ...pipe(
    PLATFORM_PACKAGES,
    Arr.map((name) => [name, PLATFORM_TYPES] as const),
    Arr.appendAll(Rec.toEntries(READONLY_ENOUGH)),
    Arr.map(([pkg, names]) => ({ from: "package" as const, name: Arr.copy(names), package: pkg })),
  ),
]

export default defineConfig({
  categories: {
    correctness: "error",
    nursery: "error",
    pedantic: "error",
    perf: "error",
    restriction: "error",
    style: "error",
    suspicious: "error",
  },
  env: { builtin: true, es2024: true, node: true, worker: true },
  globals: { Bun: "readonly" },
  ignorePatterns: ["dist/**", ".astro/**", "node_modules/**"],
  options: { typeAware: true },
  overrides: [
    {
      files: ["**/*.astro"],
      globals: { Astro: "readonly" },
      rules: { "import/unambiguous": "off" },
    },
    {
      files: ["src/worker.ts", "alchemy.run.ts", "test/e2e.run.ts", "*.config.ts"],
      rules: { "import/no-default-export": "off" },
    },
  ],
  plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "node", "jsdoc", "jest", "effecttsgo"],
  rules: {
    // Effect's unstable modules (platform services, AI, HTTP) are used on purpose.
    // The effect version is pinned exactly, so their breaking changes arrive only with an upgrade that `mise run check` covers.
    "effecttsgo/unstable-api-usage": "off",
    "eslint/new-cap": ["error", { capIsNew: false }],
    "eslint/no-duplicate-imports": ["error", { allowSeparateTypeImports: true }],
    "eslint/no-ternary": "off",
    "eslint/one-var": ["error", "never"],
    "import/no-named-export": "off",
    "import/prefer-default-export": "off",
    "jest/no-hooks": "off",
    "oxc/no-optional-chaining": "off",
    "promise/prefer-await-to-callbacks": "off",
    "promise/prefer-await-to-then": "off",
    "typescript/array-type": ["error", { default: "generic", readonly: "generic" }],
    "typescript/prefer-readonly-parameter-types": [
      "error",
      { allow: readonlyEnough, ignoreInferredTypes: true, treatMethodsAsReadonly: true },
    ],
    "typescript/promise-function-async": "off",
    "unicorn/prefer-top-level-await": "off",
    "unicorn/throw-new-error": "off",
  },
})
