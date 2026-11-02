/** Reading journal entries, through the SDK's journal resource. */
import { Array as Arr, DateTime, Effect, Option, Predicate, Schema, pipe } from "effect"
import { DateString, Id, JOURNAL_EVENT, Json, JsonList, Limit, Offset, Privacy, call, privacySetting } from "./common.ts"
import { defined, isBlank } from "./sdk-fields.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { JournalEvent } from "@hardcover/sdk"
import { Toolkit } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_JOURNAL_LIMIT = 20
const MAX_JOURNAL_LIMIT = 100
const DEFAULT_JOURNAL_OFFSET = 0
const TAG_NOT_SPOILER = false

const Tag = Schema.Struct({
  category: Schema.NonEmptyString.annotate({ description: "Tag category, e.g. Genre, Mood, Content Warning, Tag." }),
  spoiler: Schema.optionalKey(Schema.Boolean),
  tag: Schema.NonEmptyString,
})

const JournalEntryKind = Schema.Literals(["note", "quote"])
const OptionalKind = Schema.optionalKey(JournalEntryKind)
const OptionalDate = Schema.optionalKey(DateString("Entry date"))
const OptionalEdition = Schema.optionalKey(Id("Edition."))
const OptionalPrivacy = Schema.optionalKey(Privacy)
const OptionalTags = Schema.optionalKey(Schema.Array(Tag))
const OptionalText = Schema.optionalKey(Schema.NonEmptyString)
const OptionalBook = Schema.optionalKey(Id("Book id."))

const ListJournal = hardcoverTool({
  description:
    "The user's reading journal, newest first: notes, quotes, and automatic entries (status changes, ratings, progress). " +
    "Pass bookId for one book.",
  kind: "read",
  name: "hardcover_list_journal",
  parameters: Schema.Struct({
    bookId: OptionalBook,
    limit: Limit({ fallback: DEFAULT_JOURNAL_LIMIT, max: MAX_JOURNAL_LIMIT }),
    offset: Offset,
  }),
  scopes: ["read:journal"],
  success: Schema.Struct({ entries: JsonList }),
  title: "List journal entries",
})

const AddJournalEntry = hardcoverTool({
  description:
    "Adds a note or quote to the user's reading journal for a book. Without privacy, uses the account's default activity privacy.",
  kind: "create",
  name: "hardcover_add_journal_entry",
  parameters: Schema.Struct({
    bookId: Id("Book id."),
    date: OptionalDate,
    editionId: OptionalEdition,
    kind: OptionalKind,
    privacy: OptionalPrivacy,
    tags: OptionalTags,
    text: Schema.NonEmptyString,
  }),
  scopes: ["write:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Add a journal entry",
})

const UpdateJournalEntry = hardcoverTool({
  description: "Changes a journal entry's text, kind, privacy, or date.",
  destructive: true,
  kind: "update",
  name: "hardcover_update_journal_entry",
  parameters: Schema.Struct({
    date: OptionalDate,
    entryId: Id("Journal entry id."),
    kind: OptionalKind,
    privacy: OptionalPrivacy,
    text: OptionalText,
  }),
  scopes: ["write:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Edit a journal entry",
})

const DeleteJournalEntry = hardcoverTool({
  description: "Deletes one journal entry.",
  kind: "delete",
  name: "hardcover_delete_journal_entry",
  parameters: Schema.Struct({ entryId: Id("Journal entry id.") }),
  scopes: ["write:library"],
  success: Schema.Struct({ deleted: Schema.Int }),
  title: "Delete a journal entry",
})

const journalEvent = (kind: "note" | "quote" | undefined): JournalEvent | undefined =>
  Option.getOrUndefined(Predicate.isUndefined(kind) ? Option.none() : Option.some(JOURNAL_EVENT[kind]))

const journalTag = (tag: typeof Tag.Type): { readonly category: string; readonly spoiler: boolean; readonly tag: string } => ({
  category: tag.category,
  spoiler: tag.spoiler ?? TAG_NOT_SPOILER,
  tag: tag.tag,
})

const journalTags = (tags: ReadonlyArray<typeof Tag.Type> | undefined): Option.Option<ReadonlyArray<ReturnType<typeof journalTag>>> =>
  Option.map(Option.fromNullishOr(tags), (rows) => pipe(rows, Arr.map(journalTag)))

const journalHandlers = {
  hardcover_add_journal_entry: Effect.fn(function* addJournalEntry(params: typeof AddJournalEntry.parametersSchema.Type) {
    const date = params.date ?? DateTime.formatIsoDateUtc(yield* DateTime.now)
    const tags = Option.getOrUndefined(journalTags(params.tags))
    const entry = yield* call((hardcover) =>
      hardcover.client.journal.add(
        params.bookId,
        defined({
          date,
          editionId: params.editionId,
          entry: params.text,
          event: journalEvent(params.kind),
          privacy: privacySetting(params.privacy),
          tags,
        }),
      ),
    )
    return { entry }
  }),

  hardcover_delete_journal_entry: Effect.fn(function* deleteJournalEntry({ entryId }: typeof DeleteJournalEntry.parametersSchema.Type) {
    const removed = yield* call((hardcover) =>
      hardcover.client.graphql<{ delete_reading_journal: { id: number } | null }>(
        "mutation DeleteJournal($id: Int!) { delete_reading_journal(id: $id) { id } }",
        { id: entryId },
      ),
    )
    if (Predicate.isNull(removed.delete_reading_journal)) {
      return yield* HardcoverError.make({ kind: "not_found", message: `No journal entry ${entryId}.` })
    }
    return { deleted: entryId }
  }),

  hardcover_list_journal: Effect.fn(function* listJournal(params: typeof ListJournal.parametersSchema.Type) {
    const limit = params.limit ?? DEFAULT_JOURNAL_LIMIT
    const offset = params.offset ?? DEFAULT_JOURNAL_OFFSET
    const { bookId } = params
    if (Predicate.isNotUndefined(bookId)) {
      const page = yield* call((hardcover) => hardcover.client.journal.forBook(bookId, { limit, offset }))
      return { entries: page.items }
    }
    const page = yield* call((hardcover) =>
      hardcover.client.graphql<{ reading_journals: ReadonlyArray<unknown> }>(
        `query Journal($userId: Int!, $limit: Int!, $offset: Int!) {
          reading_journals(where: {user_id: {_eq: $userId}}, order_by: {action_at: desc}, limit: $limit, offset: $offset) {
            id book_id event entry action_at privacy_setting_id edition_id
          }
        }`,
        { limit, offset, userId: hardcover.userId },
      ),
    )
    return { entries: page.reading_journals }
  }),

  hardcover_update_journal_entry: Effect.fn(function* updateJournalEntry(params: typeof UpdateJournalEntry.parametersSchema.Type) {
    const patch = defined({
      date: params.date,
      entry: params.text,
      event: journalEvent(params.kind),
      privacy: privacySetting(params.privacy),
    })
    if (isBlank(patch)) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
    }
    return { entry: yield* call((hardcover) => hardcover.client.journal.update(params.entryId, patch)) }
  }),
}

const JournalToolkit = Toolkit.make(ListJournal, AddJournalEntry, UpdateJournalEntry, DeleteJournalEntry)
const JournalToolkitLive = JournalToolkit.toLayer(journalHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { JournalToolkit, JournalToolkitLive }
