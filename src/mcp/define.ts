/**
 * `hardcoverTool()` wraps `Tool.make` with this server's conventions:
 *
 * - `scopes`: every OAuth scope the tool needs. Tools are hidden from
 *   `tools/list` when the connection lacks one, and calls get a `403`
 *   step-up challenge naming them.
 * - `requires`: account features beyond scopes (Supporter membership,
 *   librarian roles) that every call needs. Shown in the title and
 *   description and in `_meta`; Hardcover itself enforces them. Scopes that
 *   carry their own requirement are also listed in `_meta`.
 * - MCP annotations derive from `kind`.
 */
import { Array as Arr, Context, Option, Record as Rec, Schema, pipe } from "effect"
import { ALL_SCOPES } from "#src/hardcover/scopes.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { Requirement } from "#src/hardcover/scopes.ts"
import { Session } from "#src/mcp/session.ts"
import { Tool } from "effect/ai"

const ToolKinds = Schema.Literals(["read", "create", "update", "delete"])
type ToolKind = typeof ToolKinds.Type

const RequirementName: Schema.Codec<Requirement> = Schema.Literals(["supporter", "librarian", "librarian:book_mapper"])

/** What a tool needs, read back from its annotations. */
interface ToolPolicy {
  readonly kind: ToolKind
  /** All of these are needed. */
  readonly scopes: ReadonlyArray<string>
  /** At least one of these is needed (for tools whose scope depends on the input). */
  readonly anyOf: Option.Option<ReadonlyArray<string>>
  readonly requires: ReadonlyArray<Requirement>
  /** Requirements that apply only to calls using these scopes. */
  readonly scopeRequires: Option.Option<Readonly<Record<string, Requirement>>>
}

/** `_meta` keys on each tool in `tools/list`. */
const META = {
  anyOf: "hardcover-oauth-mcp/scopes-any-of",
  kind: "hardcover-oauth-mcp/kind",
  /** Needed for every call. */
  requires: "hardcover-oauth-mcp/requires",
  /** Needed only for operations under particular scopes, e.g. catalog edits need a librarian role but additions don't. */
  scopeRequires: "hardcover-oauth-mcp/scope-requires",
  scopes: "hardcover-oauth-mcp/scopes",
} as const

const PolicyMeta = Schema.Struct({
  [META.anyOf]: Schema.optionalKey(Schema.Array(Schema.String)),
  [META.kind]: ToolKinds,
  [META.requires]: Schema.Array(RequirementName),
  [META.scopeRequires]: Schema.optionalKey(Schema.Record(Schema.String, RequirementName)),
  [META.scopes]: Schema.Array(Schema.String),
})

const REQUIREMENT_TEXT: Readonly<Record<Requirement, string>> = {
  librarian: "a Hardcover librarian role",
  "librarian:book_mapper": "the Hardcover librarian role book_mapper",
  supporter: "Hardcover Supporter (paid) membership",
}

const REQUIREMENT_BADGE: Readonly<Record<Requirement, string>> = {
  librarian: "Librarian",
  "librarian:book_mapper": "Librarian",
  supporter: "Supporter",
}

type ParametersSchema = Schema.Struct<Schema.Struct.Fields> | typeof Tool.EmptyParams
type SuccessSchema = Schema.Struct<Schema.Struct.Fields>

/** A tool's name, schemas, and policy; see the module comment. */
interface HardcoverToolConfig<Name extends string, Parameters extends ParametersSchema, Success extends SuccessSchema> {
  readonly name: Name
  readonly title: string
  readonly description: string
  readonly kind: ToolKind
  readonly scopes: ReadonlyArray<string>
  readonly anyOf?: ReadonlyArray<string>
  readonly requires?: ReadonlyArray<Requirement>
  readonly parameters: Parameters
  readonly success: Success
  /** Overrides the default (true only for `delete`). */
  readonly destructive?: boolean
  /** Overrides the default (true for `read` and `update`). */
  readonly idempotent?: boolean
}

/** A tool made by `hardcoverTool()`. */
type HardcoverTool<Name extends string, Parameters extends ParametersSchema, Success extends SuccessSchema> = Tool.Tool<
  Name,
  {
    readonly parameters: Parameters
    readonly success: Success
    readonly failure: typeof HardcoverError
    readonly failureMode: "error"
  },
  Session
>

/**
 * The requirements of the scopes a tool uses that carry their own, such as catalog edits needing a librarian role.
 * @param {ReadonlyArray<string>} scopes Every scope the tool may use.
 * @returns {Option.Option<Record<string, Requirement>>} Each such scope's requirement, or none if no scope has one.
 */
const scopeRequirements = (scopes: ReadonlyArray<string>): Option.Option<Readonly<Record<string, Requirement>>> => {
  const entries = pipe(
    ALL_SCOPES,
    Arr.flatMap((info) =>
      Arr.contains(scopes, info.scope)
        ? Option.toArray(Option.map(Option.fromNullishOr(info.requires), (need) => [info.scope, need] as const))
        : [],
    ),
  )
  return Arr.isReadonlyArrayNonEmpty(entries) ? Option.some(Rec.fromEntries(entries)) : Option.none()
}

/**
 * The tool's title with badges for the account features it needs.
 * @param {string} title The plain title.
 * @param {ReadonlyArray<Requirement>} requires The account features every call needs.
 * @returns {string} The title shown to people.
 */
const badgedTitle = (title: string, requires: ReadonlyArray<Requirement>): string => {
  const badges = pipe(
    requires,
    Arr.map((requirement) => REQUIREMENT_BADGE[requirement]),
    Arr.dedupe,
  )
  return Arr.isReadonlyArrayNonEmpty(badges) ? `${title} (${Arr.join(badges, ", ")})` : title
}

/**
 * The tool's description, prefixed with the account features it needs.
 * @param {string} description The plain description.
 * @param {ReadonlyArray<Requirement>} requires The account features every call needs.
 * @returns {string} The description shown to the model.
 */
const describedNeeds = (description: string, requires: ReadonlyArray<Requirement>): string =>
  Arr.isReadonlyArrayNonEmpty(requires)
    ? `Requires ${pipe(
        requires,
        Arr.map((requirement) => REQUIREMENT_TEXT[requirement]),
        Arr.join(" and "),
      )}. ${description}`
    : description

/**
 * The `_meta` that records a tool's policy.
 * @param {ToolPolicy} policy The tool's policy.
 * @returns {Record<string, unknown>} The `_meta` entries, without absent ones.
 */
const policyMeta = (policy: ToolPolicy): Readonly<Record<string, unknown>> => {
  const entries: Readonly<Record<string, Option.Option<unknown>>> = {
    [META.anyOf]: policy.anyOf,
    [META.kind]: Option.some(policy.kind),
    [META.requires]: Option.some(policy.requires),
    [META.scopeRequires]: policy.scopeRequires,
    [META.scopes]: Option.some(policy.scopes),
  }
  return Rec.getSomes(entries)
}

/**
 * Makes a tool with this server's conventions; see the module comment.
 * @param {HardcoverToolConfig} config The tool's name, schemas, and policy.
 * @returns {HardcoverTool} The tool.
 */
const hardcoverTool = <const Name extends string, Parameters extends ParametersSchema, Success extends SuccessSchema>(
  config: HardcoverToolConfig<Name, Parameters, Success>,
): HardcoverTool<Name, Parameters, Success> => {
  const requires = config.requires ?? []
  const scopeRequires = scopeRequirements(Arr.appendAll(config.scopes, config.anyOf ?? []))
  return Tool.make(config.name, {
    dependencies: [Session],
    description: describedNeeds(config.description, requires),
    failure: HardcoverError,
    parameters: config.parameters,
    success: config.success,
  })
    .annotate(Tool.Title, badgedTitle(config.title, requires))
    .annotate(Tool.Readonly, config.kind === "read")
    .annotate(Tool.Destructive, config.destructive ?? config.kind === "delete")
    .annotate(Tool.Idempotent, config.idempotent ?? (config.kind === "read" || config.kind === "update"))
    .annotate(Tool.OpenWorld, true)
    .annotate(
      Tool.Meta,
      policyMeta({ anyOf: Option.fromNullishOr(config.anyOf), kind: config.kind, requires, scopeRequires, scopes: config.scopes }),
    )
}

/**
 * The policy `hardcoverTool()` attached, read back from the tool's annotations.
 * @param {Tool.Any} tool Any tool.
 * @returns {Option.Option<ToolPolicy>} The policy, or none for tools not made by `hardcoverTool()`.
 */
const toolPolicy = (tool: Tool.Any): Option.Option<ToolPolicy> =>
  pipe(
    Context.getOption(tool.annotations, Tool.Meta),
    Option.flatMap(Schema.decodeUnknownOption(PolicyMeta)),
    Option.map((meta): ToolPolicy => ({
      anyOf: Option.fromNullishOr(meta[META.anyOf]),
      kind: meta[META.kind],
      requires: meta[META.requires],
      scopeRequires: Option.fromNullishOr(meta[META.scopeRequires]),
      scopes: meta[META.scopes],
    })),
  )

/**
 * Application module, not a public API.
 * @internal
 */
export { hardcoverTool, toolPolicy }
/**
 * Application module, not a public API.
 * @internal
 */
export type { ToolPolicy }
