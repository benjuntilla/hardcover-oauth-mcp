/**
 * The Hardcover scopes this server asks for, grouped for the consent page.
 * MCP tokens carry the same scope names as the Hardcover tokens behind them,
 * so a tool's requirements read the same on both sides.
 * Source: hardcover-docs capabilities.json (see `scripts/sync-schema.ts`).
 */
import { Array as Arr, Function, Option, pipe } from "effect"

interface ScopeInfo {
  readonly default: boolean
  readonly label: string
  /** Always granted: the server needs it to identify the user. */
  readonly required?: boolean
  readonly requires?: Requirement
  readonly scope: string
}

interface ScopeGroup {
  readonly note?: string
  readonly scopes: ReadonlyArray<ScopeInfo>
  readonly title: string
}

const SCOPE_GROUPS: ReadonlyArray<ScopeGroup> = [
  {
    scopes: [
      { default: true, label: "Your public profile (id, username, name, avatar)", required: true, scope: "read:me:content" },
      { default: true, label: "Your librarian roles, to show which librarian tools you can use", scope: "read:me:roles" },
    ],
    title: "Profile",
  },
  {
    scopes: [
      { default: true, label: "Search and read books, editions, authors, and series", scope: "read:catalog" },
      { default: true, label: "Read your library, statuses, ratings, and reading progress", scope: "read:library" },
      { default: true, label: "Add, update, and remove books, progress, dates read, and journal entries", scope: "write:library" },
      { default: true, label: "Write, edit, and delete your reviews", scope: "write:reviews" },
      { default: true, label: "Read your reading journal", scope: "read:journal" },
    ],
    title: "Books and library",
  },
  {
    scopes: [
      { default: true, label: "Read your lists", scope: "read:lists" },
      { default: true, label: "Create, edit, and delete lists and the books on them", scope: "write:lists" },
      { default: true, label: "Read your reading goals", scope: "read:goals" },
      { default: true, label: "Create, edit, and delete reading goals", scope: "write:goals" },
    ],
    title: "Lists and goals",
  },
  {
    scopes: [
      { default: true, label: "Look up other readers' public profiles", scope: "read:users" },
      { default: true, label: "Read follows, likes, and activity from people you follow", scope: "read:social" },
      { default: true, label: "Follow and unfollow, like content, block users", scope: "write:social" },
      { default: true, label: "Read your notifications", scope: "read:notifications" },
      { default: true, label: "Mark notifications read and change notification settings", scope: "write:notifications" },
      { default: true, label: "Read prompts and prompt answers", scope: "read:prompts" },
      { default: true, label: "Create prompts and answer them", scope: "write:prompts" },
    ],
    title: "Community",
  },
  {
    note: "Creating vibes, and tuning their signals, is a Supporter feature.",
    scopes: [
      { default: true, label: "Read your vibes", scope: "read:vibes" },
      { default: true, label: "Create, edit, and delete vibes", requires: "supporter", scope: "write:vibes" },
    ],
    title: "Vibes",
  },
  {
    scopes: [{ default: false, label: "Read imports, subscription, and referral data", scope: "read:account" }],
    title: "Account",
  },
  {
    note:
      "Catalog changes are public and affect every Hardcover user. Anyone can add records and fill empty fields; " +
      "editing and mappings need the matching librarian role and are dropped from the connection after sign-in without it.",
    scopes: [
      { default: false, label: "Add books, editions, authors, and series, and fill empty fields", scope: "write:catalog:append" },
      { default: false, label: "Edit existing catalog data", requires: "librarian", scope: "write:catalog:edit" },
      { default: false, label: "Edit book mappings", requires: "librarian:book_mapper", scope: "write:catalog:map" },
    ],
    title: "Catalog editing",
  },
]

const ALL_SCOPES: ReadonlyArray<ScopeInfo> = pipe(
  SCOPE_GROUPS,
  Arr.flatMap((group) => group.scopes),
)
const SUPPORTED_SCOPES: ReadonlyArray<string> = pipe(
  ALL_SCOPES,
  Arr.map((info) => info.scope),
)
const DEFAULT_SCOPES: ReadonlyArray<string> = pipe(
  ALL_SCOPES,
  Arr.filter((info) => info.default),
  Arr.map((info) => info.scope),
)
const REQUIRED_SCOPES: ReadonlyArray<string> = pipe(
  ALL_SCOPES,
  Arr.filter((info) => info.required === true),
  Arr.map((info) => info.scope),
)

/**
 * Scopes asked of Hardcover but never offered to MCP clients. `offline_access`
 * covers the refresh token the connection uses while the user is away, and
 * Hardcover only accepts it alongside `openid`.
 */
const UPSTREAM_SCOPES: ReadonlyArray<string> = ["openid", "offline_access"]

const supported = new Set(SUPPORTED_SCOPES)

/**
 * The scopes to grant: those picked that this server supports, plus the required ones, in catalogue order.
 * @param {Iterable<string>} picked Scopes the client or the consent form selected.
 * @returns {Array<string>} Supported scopes plus the required ones, in catalogue order.
 */
const normalizeScopes = (picked: Iterable<string>): Array<string> => {
  const wanted = new Set(
    pipe(
      Arr.fromIterable(picked),
      Arr.filter((scope) => supported.has(scope)),
    ),
  )
  for (const scope of REQUIRED_SCOPES) {
    wanted.add(scope)
  }
  return pipe(
    SUPPORTED_SCOPES,
    Arr.filter((scope) => wanted.has(scope)),
  )
}

/**
 * Hardcover librarian role names behind each catalog requirement. `librarian`
 * accepts any role except `appender`, which live accounts carry and which by
 * its name covers only adding (open to everyone anyway). Staff (`hardcover_admin`) satisfy every requirement.
 * `Option.none` means any non-appender role qualifies.
 */
const ROLE_FOR: Readonly<Record<Exclude<Requirement, "supporter">, Option.Option<string>>> = {
  librarian: Option.none(),
  "librarian:book_mapper": Option.some("book_mapper"),
}

const DATA_FIRST_ARITY = 2

/**
 * Whether the account's librarian roles satisfy a catalog requirement.
 * @param {ReadonlyArray<string>} roles Role names on the Hardcover account.
 * @param {Exclude<Requirement, "supporter">} requirement Catalog requirement to check.
 * @returns {boolean} True when the roles include staff or the matching librarian role.
 */
const hasLibrarianRequirement: {
  (requirement: Exclude<Requirement, "supporter">): (roles: ReadonlyArray<string>) => boolean
  (roles: ReadonlyArray<string>, requirement: Exclude<Requirement, "supporter">): boolean
} = Function.dual(DATA_FIRST_ARITY, (roles: ReadonlyArray<string>, requirement: Exclude<Requirement, "supporter">): boolean => {
  if (pipe(roles, Arr.contains("hardcover_admin"))) {
    return true
  }
  return pipe(
    ROLE_FOR[requirement],
    Option.match({
      onNone: () =>
        pipe(
          roles,
          Arr.some((name) => name !== "appender"),
        ),
      onSome: (role) => pipe(roles, Arr.contains(role)),
    }),
  )
})

const keepsScope = (roles: ReadonlyArray<string>, scope: string): boolean => {
  const requirement = pipe(
    ALL_SCOPES,
    Arr.findFirst((info) => info.scope === scope),
    Option.flatMap((info) => Option.fromNullishOr(info.requires)),
  )
  return pipe(
    requirement,
    Option.match({
      onNone: () => true,
      onSome: (needed) => needed === "supporter" || hasLibrarianRequirement(roles, needed),
    }),
  )
}

/**
 * Drops catalog scopes whose librarian role the account lacks. Unknown roles (`null`) keep everything.
 * @param {ReadonlyArray<string>} scopes Scopes already granted by the consent form.
 * @param {ReadonlyArray<string> | null} roles Librarian roles, or null when the account lookup did not return them.
 * @returns {Array<string>} Scopes the account may keep.
 */
const scopesForRoles: {
  (roles: ReadonlyArray<string> | null): (scopes: ReadonlyArray<string>) => Array<string>
  (scopes: ReadonlyArray<string>, roles: ReadonlyArray<string> | null): Array<string>
} = Function.dual(DATA_FIRST_ARITY, (scopes: ReadonlyArray<string>, roles: ReadonlyArray<string> | null): Array<string> =>
  roles === null
    ? Arr.fromIterable(scopes)
    : pipe(
        scopes,
        Arr.filter((scope) => keepsScope(roles, scope)),
      ),
)

type Requirement = "supporter" | "librarian" | "librarian:book_mapper"

export type { Requirement }
export { ALL_SCOPES, DEFAULT_SCOPES, SCOPE_GROUPS, SUPPORTED_SCOPES, UPSTREAM_SCOPES, normalizeScopes, scopesForRoles }
