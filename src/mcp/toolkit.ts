/** Every tool the server exposes, in `tools/list` order, and the layer with their handlers. */
import { AccountToolkit, AccountToolkitLive } from "#src/mcp/tools/account.ts"
import { DiscoveryToolkit, DiscoveryToolkitLive } from "#src/mcp/tools/catalog-handlers.ts"
import { GoalsToolkit, GoalsToolkitLive } from "#src/mcp/tools/goals.ts"
import { GraphQLToolkit, GraphQLToolkitLive } from "#src/mcp/tools/generic-handlers.ts"
import { JournalToolkit, JournalToolkitLive } from "#src/mcp/tools/journal.ts"
import { Layer } from "effect"
import { LibraryToolkit } from "#src/mcp/tools/library-tools.ts"
import { LibraryToolkitLive } from "#src/mcp/tools/library-handlers.ts"
import { ListsToolkit, ListsToolkitLive } from "#src/mcp/tools/list-handlers.ts"
import { PeopleToolkit, PeopleToolkitLive } from "#src/mcp/tools/social.ts"
import { Toolkit } from "effect/ai"

const HardcoverToolkit = Toolkit.merge(
  PeopleToolkit,
  DiscoveryToolkit,
  LibraryToolkit,
  JournalToolkit,
  ListsToolkit,
  GoalsToolkit,
  AccountToolkit,
  GraphQLToolkit,
)

const HardcoverToolkitLive = Layer.mergeAll(
  PeopleToolkitLive,
  DiscoveryToolkitLive,
  LibraryToolkitLive,
  JournalToolkitLive,
  ListsToolkitLive,
  GoalsToolkitLive,
  AccountToolkitLive,
  GraphQLToolkitLive,
)

/**
 * Application module, not a public API.
 * @internal
 */
export { HardcoverToolkit, HardcoverToolkitLive }
