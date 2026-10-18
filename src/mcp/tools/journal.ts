/** Reading journal entries (notes, quotes). Read: read:journal. Write: write:library. */
import { Array as Arr, DateTime, Effect, Option, Predicate, Record as Rec, Schema, pipe } from "effect"
import { DateString, Id, Json, JsonList, Limit, Offset, Privacy, first, payload, privacyId } from "./common.ts"
import { bookJournalOf, defaultPrivacy, insertJournal, journalOf, removeJournal, updateJournal } from "./journal-operations.ts"
import { HardcoverError } from "#src/hardcover/errors.ts"
import type { JournalTag } from "./journal-operations.ts"
import type { PrivacyName } from "./common.ts"
import { Session } from "#src/mcp/session.ts"
import { Toolkit } from "effect/ai"
import { hardcoverTool } from "#src/mcp/define.ts"

const DEFAULT_JOURNAL_LIMIT = 20
const MAX_JOURNAL_LIMIT = 100
const DEFAULT_JOURNAL_OFFSET = 0
const DEFAULT_ENTRY_KIND = "note"
const DEFAULT_SPOILER = false

const Tag = Schema.Struct({
  category: Schema.NonEmptyString.annotate({ description: "Tag category, e.g. Genre, Mood, Content Warning, Tag." }),
  spoiler: Schema.optionalKey(Schema.Boolean),
  tag: Schema.NonEmptyString,
})

const JournalEntryKind = Schema.Literals(["note", "quote"])

const ListJournalParams = Schema.Struct({
  bookId: Schema.optionalKey(Id("Book id.")),
  limit: Limit({ fallback: DEFAULT_JOURNAL_LIMIT, max: MAX_JOURNAL_LIMIT }),
  offset: Offset,
})

const AddJournalParams = Schema.Struct({
  bookId: Id("Book id."),
  date: Schema.optionalKey(DateString("Entry date, default today")),
  editionId: Schema.optionalKey(Id("Edition.")),
  kind: Schema.optionalKey(JournalEntryKind.annotate({ description: "Default note." })),
  privacy: Schema.optionalKey(Privacy),
  tags: Schema.optionalKey(Schema.Array(Tag)),
  text: Schema.NonEmptyString,
})

const UpdateJournalParams = Schema.Struct({
  date: Schema.optionalKey(DateString("Entry date")),
  entryId: Id("Journal entry id."),
  kind: Schema.optionalKey(JournalEntryKind),
  privacy: Schema.optionalKey(Privacy),
  text: Schema.optionalKey(Schema.NonEmptyString),
})

const ListJournal = hardcoverTool({
  description:
    "The user's reading journal, newest first: notes, quotes, and automatic entries (status changes, ratings, progress). " +
    "Pass bookId for one book.",
  kind: "read",
  name: "hardcover_list_journal",
  parameters: ListJournalParams,
  scopes: ["read:journal"],
  success: Schema.Struct({ entries: JsonList }),
  title: "List journal entries",
})

const AddJournalEntry = hardcoverTool({
  description:
    "Adds a note or quote to the user's reading journal for a book. Without privacy, uses the account's default activity privacy.",
  kind: "create",
  name: "hardcover_add_journal_entry",
  parameters: AddJournalParams,
  scopes: ["write:library"],
  success: Schema.Struct({ entry: Json }),
  title: "Add a journal entry",
})

const UpdateJournalEntry = hardcoverTool({
  description: "Changes a journal entry's text, kind, privacy, or date.",
  destructive: true,
  kind: "update",
  name: "hardcover_update_journal_entry",
  parameters: UpdateJournalParams,
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

/**
 * Today's date in UTC, as Hardcover stores entry dates.
 * @returns {Effect.Effect<string>} The date as YYYY-MM-DD.
 */
const today = (): Effect.Effect<string> =>
  Effect.gen(function* currentDate() {
    const now = yield* DateTime.now
    return DateTime.formatIsoDateUtc(now)
  })

/**
 * The privacy setting to store, or none when the caller left it to the account default.
 * @param {PrivacyName | undefined} privacy The privacy the caller asked for.
 * @returns {Option.Option<number>} Hardcover's privacy id, when one was given.
 */
const givenPrivacy = (privacy: PrivacyName | undefined): Option.Option<number> =>
  Option.map(Option.fromNullishOr(privacy), (name) => privacyId(name))

/**
 * A journal tag in the shape Hardcover's create mutation expects.
 * @param {typeof Tag.Type} tag The tag the caller sent.
 * @returns {JournalTag} The tag, with spoiler defaulting to false.
 */
const journalTag = (tag: typeof Tag.Type): JournalTag => ({
  category: tag.category,
  spoiler: pipe(
    tag.spoiler,
    Option.fromNullishOr,
    Option.getOrElse(() => DEFAULT_SPOILER),
  ),
  tag: tag.tag,
})

/**
 * The account's default activity privacy, used when a journal entry names none.
 * @returns {Effect.Effect<number, HardcoverError, Session>} Hardcover's privacy setting id.
 */
const defaultActivityPrivacy: Effect.Effect<number, HardcoverError, Session> = Effect.gen(function* accountPrivacy() {
  const data = yield* defaultPrivacy({})
  const account = yield* first({ rows: data.me, what: "account" })
  return account.activity_privacy_settings_id
})

const journalHandlers = {
  hardcover_add_journal_entry: Effect.fn(function* addJournalEntry(params: typeof AddJournalEntry.parametersSchema.Type) {
    // Hardcover requires a privacy setting here; without one, use the account's default activity privacy.
    const requestedPrivacy = givenPrivacy(params.privacy)
    const privacy = yield* Option.match(requestedPrivacy, {
      onNone: () => defaultActivityPrivacy,
      onSome: Effect.succeed,
    })
    const fallbackDate = yield* today()
    const requestedDate: Option.Option<string> = Option.fromNullishOr(params.date)
    const entryDate = Option.getOrElse(requestedDate, () => fallbackDate)
    const tags = pipe(
      params.tags ?? [],
      Arr.map((tag) => journalTag(tag)),
    )
    const data = yield* insertJournal({
      object: {
        action_at: entryDate,
        book_id: params.bookId,
        edition_id: params.editionId,
        entry: params.text,
        event: params.kind ?? DEFAULT_ENTRY_KIND,
        privacy_setting_id: privacy,
        tags,
      },
    })
    const inserted = yield* payload({ field: "insert_reading_journal", value: data.insert_reading_journal })
    return { entry: inserted.reading_journal }
  }),

  hardcover_delete_journal_entry: Effect.fn(function* deleteJournalEntry({ entryId }: typeof DeleteJournalEntry.parametersSchema.Type) {
    const data = yield* removeJournal({ id: entryId })
    yield* payload({ field: "delete_reading_journal", value: data.delete_reading_journal })
    return { deleted: entryId }
  }),

  hardcover_list_journal: Effect.fn(function* listJournal({
    bookId,
    limit = DEFAULT_JOURNAL_LIMIT,
    offset = DEFAULT_JOURNAL_OFFSET,
  }: typeof ListJournal.parametersSchema.Type) {
    const { hcUserId } = yield* Session
    const data = yield* Predicate.isNotUndefined(bookId)
      ? bookJournalOf({ bookId, limit, offset, userId: hcUserId })
      : journalOf({ limit, offset, userId: hcUserId })
    return { entries: data.reading_journals }
  }),

  hardcover_update_journal_entry: Effect.fn(function* updateJournalEntry(params: typeof UpdateJournalEntry.parametersSchema.Type) {
    const object = {
      action_at: params.date,
      entry: params.text,
      event: params.kind,
      privacy_setting_id: Option.getOrUndefined(givenPrivacy(params.privacy)),
    }
    if (pipe(object, Rec.every(Predicate.isUndefined))) {
      return yield* HardcoverError.make({ kind: "invalid", message: "Nothing to change." })
    }
    const data = yield* updateJournal({ id: params.entryId, object })
    const updated = yield* payload({ field: "update_reading_journal", value: data.update_reading_journal })
    return { entry: updated.reading_journal }
  }),
}

const JournalToolkit = Toolkit.make(ListJournal, AddJournalEntry, UpdateJournalEntry, DeleteJournalEntry)
const JournalToolkitLive = JournalToolkit.toLayer(journalHandlers)

/**
 * Application module, not a public API.
 * @internal
 */
export { JournalToolkit, JournalToolkitLive }
