/** Single-stroke lettering from Hershey Sans 1-stroke, the plotter font, for the drawings' labels. */
import { Array as Arr, pipe } from "effect"
import type { Point, Polyline } from "#root/scripts/brand/book.ts"

interface Glyph {
  readonly advance: number
  readonly strokes: ReadonlyArray<Polyline>
}

/** A string's strokes at cap height 1, with the left edge of its ink at x 0 and its baseline at y 0. */
interface Text {
  readonly strokes: ReadonlyArray<Polyline>
  readonly width: number
}

interface Lettering {
  readonly layout: (content: string) => Text
}

/** The font's cap height, in its own units (y up). */
const CAP_HEIGHT = 662
/** Extra space after each letter, as a fraction of the cap height. */
const TRACKING = 0.2
const BLANK: Glyph = { advance: 0, strokes: [] }

const GLYPH = /<glyph unicode="(?<char>[^"]*)"[^>]*?horiz-adv-x="(?<advance>[\d.]+)"(?: d="(?<path>[^"]*)")?/gv
const STROKE = /M(?<points>[^M]*)/gv
const POINT = /(?<px>-?[\d.]+) (?<py>-?[\d.]+)/gv

const stroke = (points: string): Polyline =>
  pipe(
    [...points.matchAll(POINT)],
    Arr.map((point): Point => [Number(point.groups?.px), Number(point.groups?.py)]),
  )

const glyph = (groups: Readonly<Partial<Record<"advance" | "char" | "path", string>>>): readonly [string, Glyph] => {
  const strokes = pipe(
    [...(groups.path ?? "").matchAll(STROKE)],
    Arr.map((path) => stroke(path.groups?.points ?? "")),
  )
  return [groups.char ?? "", { advance: Number(groups.advance), strokes }]
}

const shift = (strokes: ReadonlyArray<Polyline>, by: number): ReadonlyArray<Polyline> =>
  pipe(strokes, Arr.map(Arr.map(([px, py]): Point => [(by + px) / CAP_HEIGHT, py / CAP_HEIGHT])))

/**
 * Lettering in the font an SVG font file defines.
 * @param {string} fontSvg The SVG font's source.
 * @returns {Lettering} Its lettering.
 */
const makeLettering = (fontSvg: string): Lettering => {
  const glyphs = new Map(
    pipe(
      [...fontSvg.matchAll(GLYPH)],
      Arr.map((match) => glyph(match.groups ?? {})),
    ),
  )
  const space = glyphs.get(" ") ?? BLANK
  const layout = (content: string): Text => {
    let pen = 0
    const placed: Array<Polyline> = []
    for (const char of content) {
      const { advance, strokes } = glyphs.get(char) ?? space
      placed.push(...shift(strokes, pen))
      pen += advance + TRACKING * CAP_HEIGHT
    }
    const xs = pipe(
      placed,
      Arr.flatten,
      Arr.map(([px]) => px),
    )
    const left = Math.min(...xs)
    return { strokes: pipe(placed, Arr.map(Arr.map(([px, py]): Point => [px - left, py]))), width: Math.max(...xs) - left }
  }
  return { layout }
}

export { makeLettering }
export type { Lettering }
