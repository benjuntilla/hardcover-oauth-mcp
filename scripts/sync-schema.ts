/**
 * Regenerates `src/generated/hardcover-api.json` from Hardcover's published API
 * docs (github.com/hardcoverapp/hardcover-docs) at a pinned commit.
 *
 *   mise run schema:sync              # pinned commit
 *   mise run schema:sync -- <sha|ref> # another commit, e.g. main
 *
 * The output is a compact index the Worker ships with: every root operation an
 * API token may call (with arguments, return type, and scopes) and a one-line
 * field list for every type, so `hardcover_find_operations` and
 * `hardcover_describe_type` work without parsing the 600 KB SDL at runtime.
 */
import { Array as Arr, Effect, Layer, Option, Record as Rec, Schema, pipe } from "effect"
import { DOCS_REPOSITORY, fetchText } from "#root/scripts/sync-fetch.ts"
import { ScriptError, writeText } from "#root/scripts/script-io.ts"
import { indexOperations, indexTypes } from "#root/scripts/sync-index.ts"
import { FetchHttpClient } from "effect/http"
import { buildSchema } from "graphql"

const PINNED = "aaacbc047e4a81c99c5263cd400532b0a3933d1d"
const ARG_INDEX = 2
const KILOBYTE = 1024
const SCHEMA_PATH = "schema.graphql"
const CAPABILITIES_PATH = "capabilities.json"
const SCOPES_PATH = "capability-scopes.json"
const PAT_ONLY_SCOPE = "all"

const ref = pipe(
  process.argv,
  Arr.get(ARG_INDEX),
  Option.getOrElse(() => PINNED),
)
const base = `https://raw.githubusercontent.com/${DOCS_REPOSITORY}/${ref}`

const CapabilityScope = Schema.Struct({
  action: Schema.NullOr(Schema.String),
  arguments: Schema.optionalKey(Schema.Array(Schema.String)),
  columns: Schema.optionalKey(Schema.Array(Schema.String)),
  description: Schema.String,
  implies: Schema.optionalKey(Schema.Array(Schema.String)),
  scope: Schema.String,
})

const CapabilityOperation = Schema.Struct({
  operation: Schema.String,
  tables: Schema.Array(Schema.String),
  type: Schema.String,
})

const Capabilities = Schema.Struct({
  operations: Schema.Array(CapabilityOperation),
  scopes: Schema.Array(CapabilityScope),
})

const ScopeSides = Schema.Struct({ read: Schema.Array(Schema.String), write: Schema.Array(Schema.String) })
const ScopeMap = Schema.Record(Schema.String, ScopeSides)

interface TypeShape {
  readonly fields?: ReadonlyArray<string>
  readonly kind: string
  readonly types?: ReadonlyArray<string>
  readonly values?: ReadonlyArray<string>
}

interface OperationEntry {
  readonly args: string
  readonly description?: string
  readonly kind: "query" | "mutation"
  readonly returns: string
  readonly scopes: ReadonlyArray<string>
}

interface ApiIndex {
  readonly operations: Readonly<Record<string, OperationEntry>>
  readonly scopes: ReadonlyArray<{
    readonly action: string | null
    readonly arguments: ReadonlyArray<string>
    readonly columns: ReadonlyArray<string>
    readonly description: string
    readonly implies: ReadonlyArray<string>
    readonly scope: string
  }>
  readonly source: { readonly ref: string; readonly repository: string }
  readonly types: Readonly<Record<string, TypeShape & { readonly description?: string }>>
}

const scopeEntry = (entry: typeof CapabilityScope.Type): ApiIndex["scopes"][number] => ({
  action: entry.action,
  arguments: entry.arguments ?? [],
  columns: entry.columns ?? [],
  description: entry.description,
  implies: entry.implies ?? [],
  scope: entry.scope,
})

const scopeEntries = (scopes: ReadonlyArray<typeof CapabilityScope.Type>): ApiIndex["scopes"] =>
  pipe(
    scopes,
    Arr.filter((entry) => entry.scope !== PAT_ONLY_SCOPE),
    Arr.map(scopeEntry),
  )

const failedJson = (cause: unknown): ScriptError => ScriptError.make({ cause, message: "Hardcover docs JSON did not match" })

const decodeCapabilities = (text: string): Effect.Effect<typeof Capabilities.Type, ScriptError> =>
  pipe(text, Schema.decodeEffect(Schema.fromJsonString(Capabilities)), Effect.mapError(failedJson))

const decodeScopes = (text: string): Effect.Effect<typeof ScopeMap.Type, ScriptError> =>
  pipe(text, Schema.decodeEffect(Schema.fromJsonString(ScopeMap)), Effect.mapError(failedJson))

const IndexJson = Schema.fromJsonString(Schema.Unknown)

const encodeIndex = (index: ApiIndex): Effect.Effect<string, ScriptError> =>
  Schema.encodeEffect(IndexJson)(index).pipe(
    Effect.mapError((cause) => ScriptError.make({ cause, message: "Could not encode the API index" })),
  )

const buildIndex = (sdl: string, capabilitiesText: string, scopesText: string): Effect.Effect<ApiIndex, ScriptError> =>
  Effect.gen(function* assembleIndex() {
    const capabilities = yield* decodeCapabilities(capabilitiesText)
    const operationScopes = yield* decodeScopes(scopesText)
    const schema = buildSchema(sdl, { assumeValidSDL: true })
    const allowed = new Set(
      pipe(
        capabilities.operations,
        Arr.map((operation) => operation.operation),
      ),
    )
    return {
      operations: indexOperations({ allowed, operationScopes, schema }),
      scopes: scopeEntries(capabilities.scopes),
      source: { ref, repository: DOCS_REPOSITORY },
      types: indexTypes(schema),
    }
  })

const writeOutputs = (sdl: string, index: ApiIndex): Effect.Effect<void, ScriptError> =>
  Effect.gen(function* writeFiles() {
    const encoded = yield* encodeIndex(index)
    const out = new URL("../src/generated/hardcover-api.json", import.meta.url)
    const fixture = new URL("../test/fixtures/hardcover-schema.graphql", import.meta.url)
    yield* writeText({ text: `${encoded}\n`, url: out })
    // The full SDL is kept for tests only (it validates every tool's GraphQL); the Worker never loads it.
    // Hardcover's docs are MIT licensed (Copyright (c) 2024 Hardcover LLC).
    yield* writeText({ text: `# From hardcoverapp/hardcover-docs@${ref} (MIT, Copyright (c) 2024 Hardcover LLC)\n${sdl}`, url: fixture })
    const kilobytes = Math.round(encoded.length / KILOBYTE)
    yield* Effect.logInfo(
      `wrote ${out.pathname}: ${pipe(index.operations, Rec.keys, Arr.length)} operations, ${pipe(index.types, Rec.keys, Arr.length)} types, ${kilobytes} KB (${ref})`,
    )
  })

const fetchedDocs = Effect.all(
  [fetchText({ base, path: SCHEMA_PATH }), fetchText({ base, path: CAPABILITIES_PATH }), fetchText({ base, path: SCOPES_PATH })],
  { concurrency: "unbounded" },
)

const syncSchema = Effect.gen(function* syncSchema() {
  const [sdl, capabilitiesText, scopesText] = yield* fetchedDocs
  const index = yield* buildIndex(sdl, capabilitiesText, scopesText)
  yield* writeOutputs(sdl, index)
})

const MainLayer = Layer.provideMerge(Layer.effectDiscard(syncSchema), FetchHttpClient.layer)

if (import.meta.main) {
  Effect.runFork(Layer.launch(MainLayer))
}
