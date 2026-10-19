/** The icon as SVG on a 512-unit square, at three levels of detail. */
import type { Annotations, Dimensioning } from "#root/scripts/brand/annotations.ts"
import { Array as Arr, Option, pipe } from "effect"
import { CENTER_LINES, HATCH_LINES, HATCH_OUTLINE, SPARKLE_CUTOUTS } from "#root/scripts/brand/cover.ts"
import type { Point, Polyline } from "#root/scripts/brand/book.ts"
import type { Lettering } from "#root/scripts/brand/lettering.ts"
import { bookOutline } from "#root/scripts/brand/outline.ts"
import { dimensions } from "#root/scripts/brand/annotations.ts"

/**
 * `bold` is a heavy outline that holds up at 16 to 48 pixels, `icon` adds the main dimensions and the hatching,
 * and `full` adds captions, the thickness, and the corner radius.
 */
type Level = "bold" | "full" | "icon"

/** Dimensioning, with its arrowheads' length and its lines' width in pixels. */
interface Marks extends Dimensioning {
  readonly arrow: number
  readonly thin: number
}

interface Style {
  readonly ink: string
  readonly marks: Option.Option<Marks>
  readonly pageLines: number
  readonly stroke: number
}

/** Drawing units on the page mapped to pixels, with the drawing centered inside the margins. */
interface Frame {
  readonly scale: number
  readonly toPixels: (point: Point) => Point
}

const STYLES: Readonly<Record<Level, Style>> = {
  bold: { ink: "#000", marks: Option.none(), pageLines: 2, stroke: 20 },
  full: {
    ink: "#1a1a1a",
    marks: Option.some({ arrow: 9, complete: true, number: 0.95, offset: 2.4, thin: 0.85 }),
    pageLines: 3,
    stroke: 1.9,
  },
  icon: {
    ink: "#1a1a1a",
    marks: Option.some({ arrow: 15, complete: false, number: 1.55, offset: 2.6, thin: 1.68 }),
    pageLines: 3,
    stroke: 4,
  },
}

const PAPER = "#fff"
const SIZE = 512
/** The drawing spans this much of the tile, leaving an 8% margin on each side. */
const FILL = 0.84
const HALF = 0.5
const NEXT = 1
const DECIMALS = 2
const DASH_DECIMALS = 1
/** The hatching's widths, in drawing units so it looks the same at every level. */
const HATCH_WIDTH = 0.0608
const HATCH_OUTLINE_WIDTH = 0.076
/** Arrowheads are this many times as long as they are half wide. */
const ARROW_ASPECT = 7
/** Lettering is drawn slightly heavier than the thin lines, so it reads at the same weight. */
const TEXT_WEIGHT = 1.05
/** The center lines' long dash, gap, and short dash, as multiples of their width. */
const CENTER_DASH = { dash: 14, dot: 2.5, gap: 3.5 } as const
const GRID_DIVISIONS = 16

const extent = (values: ReadonlyArray<number>): { readonly middle: number; readonly size: number } => {
  const min = Math.min(...values)
  const max = Math.max(...values)
  return { middle: (min + max) * HALF, size: max - min }
}

const fit = (lines: ReadonlyArray<Polyline>): Frame => {
  const points = Arr.flatten(lines)
  const across = extent(
    pipe(
      points,
      Arr.map(([px]) => px),
    ),
  )
  const up = extent(
    pipe(
      points,
      Arr.map(([, py]) => py),
    ),
  )
  const scale = (SIZE * FILL) / Math.max(across.size, up.size)
  return {
    scale,
    toPixels: ([px, py]) => [SIZE * HALF + (px - across.middle) * scale, SIZE * HALF - (py - up.middle) * scale],
  }
}

const coordinates = ([px, py]: Point): string => `${px.toFixed(DECIMALS)} ${py.toFixed(DECIMALS)}`

const pathData = (frame: Frame, lines: ReadonlyArray<Polyline>): string =>
  pipe(
    lines,
    Arr.map((line) => `M${pipe(line, Arr.map(frame.toPixels), Arr.map(coordinates), Arr.join("L"))}`),
    Arr.join(""),
  )

// The hatching is clipped to its outline, and the sparkles are cut out of it in the paper's color.
const hatching = (frame: Frame, ink: string): string =>
  `<clipPath id="active"><path d="${pathData(frame, [HATCH_OUTLINE])}Z"/></clipPath>` +
  `<path d="${pathData(frame, HATCH_LINES)}" clip-path="url(#active)" fill="none" stroke="${ink}" stroke-width="${(HATCH_WIDTH * frame.scale).toFixed(DECIMALS)}" opacity="0.8"/>` +
  `<path d="${pathData(frame, [HATCH_OUTLINE])}" fill="none" stroke="${ink}" stroke-width="${(HATCH_OUTLINE_WIDTH * frame.scale).toFixed(DECIMALS)}"/>` +
  `<path d="${pathData(frame, SPARKLE_CUTOUTS)}" fill="${PAPER}"/>`

const arrowhead = (frame: Frame, length: number, [tip, tail]: readonly [Point, Point]): string => {
  const [tipX, tipY] = frame.toPixels(tip)
  const [tailX, tailY] = frame.toPixels(tail)
  const distance = Math.hypot(tailX - tipX, tailY - tipY)
  const ux = (tipX - tailX) / distance
  const uy = (tipY - tailY) / distance
  const half = length / ARROW_ASPECT
  const baseX = tipX - ux * length
  const baseY = tipY - uy * length
  return `M${coordinates([tipX, tipY])}L${coordinates([baseX - uy * half, baseY + ux * half])}L${coordinates([baseX + uy * half, baseY - ux * half])}Z`
}

const lineWork = (frame: Frame, ink: string, detail: { readonly annotations: Annotations; readonly marks: Marks }): string => {
  const { annotations, marks } = detail
  const width = marks.thin.toFixed(DECIMALS)
  const dashes = pipe(
    [CENTER_DASH.dash, CENTER_DASH.gap, CENTER_DASH.dot, CENTER_DASH.gap],
    Arr.map((length) => (marks.thin * length).toFixed(DASH_DECIMALS)),
    Arr.join(" "),
  )
  const arrowheads = pipe(
    annotations.arrows,
    Arr.map((arrow) => arrowhead(frame, marks.arrow, arrow)),
    Arr.join(""),
  )
  return (
    `<path d="${pathData(frame, CENTER_LINES)}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-dasharray="${dashes}"/>` +
    `<path d="${pathData(frame, annotations.thin)}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linejoin="round"/>` +
    `<path d="${arrowheads}" fill="${ink}"/>` +
    `<path d="${pathData(frame, annotations.text)}" fill="none" stroke="${ink}" stroke-width="${(marks.thin * TEXT_WEIGHT).toFixed(DECIMALS)}" stroke-linecap="round" stroke-linejoin="round"/>`
  )
}

/**
 * The drawing's SVG elements, for a 512-unit square view box.
 * @param {object} options What to draw.
 * @param {Lettering} options.lettering The labels' lettering.
 * @param {Level} options.level How much detail to draw.
 * @returns {string} The SVG elements.
 */
const drawing = (options: { readonly lettering: Lettering; readonly level: Level }): string => {
  const { ink, marks, pageLines, stroke } = STYLES[options.level]
  const outline = bookOutline(pageLines)
  const detail = pipe(
    marks,
    Option.map((style) => ({ annotations: dimensions({ lettering: options.lettering, style }), marks: style })),
  )
  const frame = fit(
    Option.match(detail, {
      onNone: () => outline,
      onSome: ({ annotations }) => [...outline, ...annotations.thin, ...annotations.text],
    }),
  )
  const details = Option.match(detail, {
    onNone: () => "",
    onSome: (annotated) => hatching(frame, ink) + lineWork(frame, ink, annotated),
  })
  return `${details}<path d="${pathData(frame, outline)}" fill="none" stroke="${ink}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`
}

const grid = (ink: string): string => {
  const step = SIZE / GRID_DIVISIONS
  const lines = pipe(
    Arr.makeBy(GRID_DIVISIONS - NEXT, (index) => (index + NEXT) * step),
    Arr.map((at) => `M${at} 0V${SIZE}M0 ${at}H${SIZE}`),
    Arr.join(""),
  )
  return `<path d="${lines}" stroke="${ink}" stroke-width="1" opacity="0.1"/>`
}

/**
 * The drawing as a standalone SVG on a white square.
 * @param {object} options What to draw.
 * @param {boolean} options.grid Whether to draw a grid behind it.
 * @param {Lettering} options.lettering The labels' lettering.
 * @param {Level} options.level How much detail to draw.
 * @returns {string} The SVG document.
 */
const tile = (options: { readonly grid: boolean; readonly lettering: Lettering; readonly level: Level }): string => {
  const { ink } = STYLES[options.level]
  const background = `<rect width="${SIZE}" height="${SIZE}" fill="${PAPER}"/>${options.grid ? grid(ink) : ""}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">${background}${drawing(options)}</svg>\n`
}

export { SIZE, drawing, tile }
