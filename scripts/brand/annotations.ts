/**
 * The marks of a dimensioned drawing, in the style of Apple's accessory drawings: dimension lines broken by their
 * values, center lines through the sparkles, and hatching on the cover. Everything is in drawing units on the page.
 */
import { Array as Arr, pipe } from "effect"
import {
  FRONT,
  HEIGHT,
  OBLIQUE_RIGHT,
  OBLIQUE_UP,
  RADIUS,
  RIGHT,
  THICKNESS,
  TOP,
  WIDTH,
  onBack,
  onCover,
} from "#root/scripts/brand/book.ts"
import type { Point, Polyline } from "#root/scripts/brand/book.ts"
import type { Lettering } from "#root/scripts/brand/lettering.ts"

interface Dimensioning {
  /** Whether to caption the dimensions and add the thickness and the corner radius. */
  readonly complete: boolean
  /** The values' cap height. */
  readonly number: number
  /** How far the dimension lines sit from the cover's edges. */
  readonly offset: number
}

/** Thin lines, lettering, and arrowheads, each arrow from its tip toward its tail. */
interface Annotations {
  readonly arrows: ReadonlyArray<readonly [Point, Point]>
  readonly text: ReadonlyArray<Polyline>
  readonly thin: ReadonlyArray<Polyline>
}

interface Direction {
  readonly dx: number
  readonly dy: number
}

interface Placement {
  readonly along: Direction
  readonly cap: number
  readonly center: Point
}

interface DimensionLine {
  readonly along: Direction
  readonly caption: string
  readonly center: Point
  readonly from: Point
  readonly to: Point
  readonly value: number
}

const HALF = 0.5
/** The cover's center line, across or along. */
const MIDLINE = 0
const DECIMALS = 2
const MILLIMETRES_PER_UNIT = 10
const HORIZONTAL: Direction = { dx: 1, dy: 0 }
const VERTICAL: Direction = { dx: 0, dy: 1 }

const CAPTION = 0.62
/** Space around a value where it breaks its dimension line, and between a value and its caption. */
const PAD = 0.35
/** The gap between the cover and an extension line. */
const GAP = 0.5
/** How far extension lines run past their dimension line. */
const OVERSHOOT = 0.7
const THICKNESS_OFFSET = 3.5
const THICKNESS_TEXT_GAP = 0.6
const LEADER_RISE = 1.5
const LEADER_SHOULDER = 0.9
const DIAGONAL = Math.PI * HALF * HALF

const format = (value: number): string => (value * MILLIMETRES_PER_UNIT).toFixed(DECIMALS)

const label = (
  lettering: Lettering,
  content: string,
  { along, cap, center }: Placement,
): { readonly half: number; readonly strokes: ReadonlyArray<Polyline> } => {
  const text = lettering.layout(content)
  const [cx, cy] = center
  const strokes = pipe(
    text.strokes,
    Arr.map(
      Arr.map(([px, py]) => {
        const across = (px - text.width * HALF) * cap
        const up = (py - HALF) * cap
        return onCover([cx + along.dx * across - along.dy * up, cy + along.dy * across + along.dx * up])
      }),
    ),
  )
  return { half: text.width * cap * HALF, strokes }
}

const dimension = (lettering: Lettering, style: Dimensioning, line: DimensionLine): Annotations => {
  const { dx, dy } = line.along
  const [cx, cy] = line.center
  const value = label(lettering, format(line.value), { along: line.along, cap: style.number, center: line.center })
  const breakStart: Point = [cx - dx * value.half - dx * PAD, cy - dy * value.half - dy * PAD]
  const breakEnd: Point = [cx + dx * value.half + dx * PAD, cy + dy * value.half + dy * PAD]
  const below = style.number * HALF + PAD + CAPTION * HALF
  const caption = style.complete
    ? label(lettering, line.caption, { along: line.along, cap: CAPTION, center: [cx + dy * below, cy - dx * below] }).strokes
    : []
  return {
    arrows: [
      [onCover(line.from), onCover(breakStart)],
      [onCover(line.to), onCover(breakEnd)],
    ],
    text: [...value.strokes, ...caption],
    thin: [
      [onCover(line.from), onCover(breakStart)],
      [onCover(breakEnd), onCover(line.to)],
    ],
  }
}

const coverDimensions = (lettering: Lettering, style: Dimensioning): ReadonlyArray<Annotations> => [
  {
    arrows: [],
    text: [],
    thin: [
      [onCover([-RIGHT, TOP + GAP]), onCover([-RIGHT, TOP + style.offset + OVERSHOOT])],
      [onCover([RIGHT, TOP + GAP]), onCover([RIGHT, TOP + style.offset + OVERSHOOT])],
      [onCover([RIGHT + GAP, TOP]), onCover([RIGHT + style.offset + OVERSHOOT, TOP])],
      [onCover([RIGHT + GAP, -TOP]), onCover([RIGHT + style.offset + OVERSHOOT, -TOP])],
    ],
  },
  dimension(lettering, style, {
    along: HORIZONTAL,
    caption: "COVER WIDTH",
    center: [MIDLINE, TOP + style.offset],
    from: [-RIGHT, TOP + style.offset],
    to: [RIGHT, TOP + style.offset],
    value: WIDTH,
  }),
  dimension(lettering, style, {
    along: VERTICAL,
    caption: "COVER HEIGHT",
    center: [RIGHT + style.offset, MIDLINE],
    from: [RIGHT + style.offset, -TOP],
    to: [RIGHT + style.offset, TOP],
    value: HEIGHT,
  }),
]

// The thickness runs into the page, so its text sits beside its dimension line's midpoint rather than breaking it.
const thickness = (lettering: Lettering, style: Dimensioning): Annotations => {
  const lineX = -RIGHT - THICKNESS_OFFSET
  const frontEnd = onCover([lineX, -TOP])
  const backEnd = onBack([lineX, -TOP])
  const midX = lineX - FRONT * OBLIQUE_RIGHT
  const midY = -TOP - FRONT * OBLIQUE_UP
  const textX = midX - THICKNESS_TEXT_GAP - lettering.layout("THICKNESS").width * CAPTION * HALF
  const value = label(lettering, format(THICKNESS), {
    along: HORIZONTAL,
    cap: style.number,
    center: [textX, midY + (CAPTION + PAD) * HALF],
  })
  const caption = label(lettering, "THICKNESS", {
    along: HORIZONTAL,
    cap: CAPTION,
    center: [textX, midY - style.number * HALF - PAD * HALF],
  })
  return {
    arrows: [
      [frontEnd, backEnd],
      [backEnd, frontEnd],
    ],
    text: [...value.strokes, ...caption.strokes],
    thin: [
      [onCover([-RIGHT - GAP, -TOP]), onCover([lineX - OVERSHOOT, -TOP])],
      [onBack([-RIGHT - GAP, -TOP]), onBack([lineX - OVERSHOOT, -TOP])],
      [frontEnd, backEnd],
    ],
  }
}

// A leader from the top right corner's arc to the radius, which both rounded corners share.
const cornerRadius = (lettering: Lettering, style: Dimensioning): Annotations => {
  const arcPoint: Point = [RIGHT - RADIUS + RADIUS * Math.cos(DIAGONAL), TOP - RADIUS + RADIUS * Math.sin(DIAGONAL)]
  const [arcX, arcY] = arcPoint
  const elbow: Point = [arcX + LEADER_RISE, arcY + LEADER_RISE]
  const [elbowX, elbowY] = elbow
  const content = `2X R${format(RADIUS)}`
  const half = lettering.layout(content).width * style.number * HALF
  const text = label(lettering, content, { along: HORIZONTAL, cap: style.number, center: [elbowX + LEADER_SHOULDER + PAD + half, elbowY] })
  return {
    arrows: [[onCover(elbow), onCover(arcPoint)]],
    text: text.strokes,
    thin: [[onCover(arcPoint), onCover(elbow), onCover([elbowX + LEADER_SHOULDER, elbowY])]],
  }
}

/**
 * The dimensions, with their extension lines, lettering, and arrows.
 * @param {object} options The lettering and how to dimension.
 * @param {Lettering} options.lettering The values' and captions' lettering.
 * @param {Dimensioning} options.style How much to dimension, and at what size.
 * @returns {Annotations} The dimensions' line work.
 */
const dimensions = (options: { readonly lettering: Lettering; readonly style: Dimensioning }): Annotations => {
  const { lettering, style } = options
  const parts = [
    ...coverDimensions(lettering, style),
    ...(style.complete ? [thickness(lettering, style), cornerRadius(lettering, style)] : []),
  ]
  return {
    arrows: pipe(
      parts,
      Arr.flatMap((part) => part.arrows),
    ),
    text: pipe(
      parts,
      Arr.flatMap((part) => part.text),
    ),
    thin: pipe(
      parts,
      Arr.flatMap((part) => part.thin),
    ),
  }
}

export { dimensions }
export type { Annotations, Dimensioning }
