/** Drops unset fields so an SDK patch sends only what the caller asked to change. */
import { Predicate, Record as Rec } from "effect"

const NONE = 0

/**
 * A patch with the unset fields left out.
 * @param {object} fields The fields the caller may have set.
 * @returns {object} The fields that were set.
 */
const defined = (fields: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Rec.toEntries(fields)) {
    if (Predicate.isNotUndefined(value)) {
      kept[key] = value
    }
  }
  return kept
}

/**
 * Whether a patch has any field set.
 * @param {Readonly<Record<string, unknown>>} fields The patch.
 * @returns {boolean} True when every field was left unset.
 */
const isBlank = (fields: Readonly<Record<string, unknown>>): boolean => Rec.keys(fields).length === NONE

/**
 * Application module, not a public API.
 * @internal
 */
export { defined, isBlank }
