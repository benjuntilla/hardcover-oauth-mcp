/** Status names and the current calendar date, shared by the library tools. */
import { DateTime, Effect, Option, Predicate, Record as Rec, Struct } from "effect"
import { STATUS_NAMES } from "./common.ts"

const ISO_DATE_LENGTH = 10
const UNKNOWN_STATUS = "status"

/**
 * Today's date as Hardcover expects it.
 * @returns {Effect.Effect<string>} The date, YYYY-MM-DD.
 */
const ISO_DATE_START = 0

const calendarDate = (now: Readonly<DateTime.DateTime>): string => {
  const isoDate = DateTime.formatIsoDateUtc(now)
  const dateEnd = ISO_DATE_LENGTH + ISO_DATE_START
  return isoDate.slice(ISO_DATE_START, dateEnd)
}

const today = (): Effect.Effect<string> => DateTime.now.pipe(Effect.map(calendarDate))

/**
 * A readable status name for a status id, when the row has one.
 * @param {unknown} row A library row.
 * @returns {Option.Option<string>} The status name.
 */
const statusName = (row: object): Option.Option<string> => {
  if (!Predicate.hasProperty("status_id")(row) || !Predicate.isNumber(row.status_id)) {
    return Option.none()
  }
  return Option.some(STATUS_NAMES[row.status_id] ?? `${UNKNOWN_STATUS} ${row.status_id}`)
}

/**
 * A library row with a readable `status` next to `status_id`.
 * @param {unknown} row The row Hardcover returned, or null when there is no entry.
 * @returns {unknown} The same row, plus `status` when it has a status id.
 */
const named = (row: unknown): unknown => {
  if (Predicate.isNull(row) || !Predicate.isObject(row)) {
    return row
  }
  return Option.match(statusName(row), {
    onNone: () => row,
    onSome: (status) => Struct.assign(Rec.fromEntries([["status", status]]))(row),
  })
}

export { named, today }
