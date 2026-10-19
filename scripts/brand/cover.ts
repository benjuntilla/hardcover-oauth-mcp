/**
 * What the detailed levels draw on the front cover: hatching inside an inset outline, with the sparkles cut out of it,
 * and dash-dot center lines through the sparkles. Everything is in drawing units on the page.
 */
import { Array as Arr, pipe } from "effect"
import { HEIGHT, RADIUS, RIGHT, SPARKLES, TOP, WIDTH, onCover, sparkleOutline } from "#root/scripts/brand/book.ts"
import type { Point, Polyline } from "#root/scripts/brand/book.ts"
import { MathUtils } from "three"

/** The center lines run past each sparkle by these multiples of its half-width and half-height. */
const CENTER_LINE_ACROSS = 1.3
const CENTER_LINE_ALONG = 1.2
/** The hatching stays this far inside the cover's edge. */
const HATCH_INSET = 1.3
/** How much of the inset the hatching's corners give back, so they stay round. */
const HATCH_CORNER_EASE = 0.6
const HATCH_SPACING = 0.42
const ARC_STEPS = 12
const NEXT = 1
const ARC_DEGREES = { down: -90, right: 0, up: 90 } as const

const CENTER_LINES: ReadonlyArray<Polyline> = pipe(
  SPARKLES,
  Arr.flatMap(({ cx, cy, halfHeight, halfWidth }): ReadonlyArray<Polyline> => [
    [onCover([cx - halfWidth * CENTER_LINE_ACROSS, cy]), onCover([cx + halfWidth * CENTER_LINE_ACROSS, cy])],
    [onCover([cx, cy - halfHeight * CENTER_LINE_ALONG]), onCover([cx, cy + halfHeight * CENTER_LINE_ALONG])],
  ]),
)

const arc = (center: Point, radius: number, degrees: { readonly from: number; readonly to: number }): Polyline => {
  const [cx, cy] = center
  return Arr.makeBy(ARC_STEPS + NEXT, (step) => {
    const angle = MathUtils.degToRad(degrees.from + ((degrees.to - degrees.from) * step) / ARC_STEPS)
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]
  })
}

const HATCH_BOUNDS = {
  bottom: -TOP + HATCH_INSET,
  corner: RADIUS - HATCH_INSET * HATCH_CORNER_EASE,
  left: -RIGHT + HATCH_INSET,
  right: RIGHT - HATCH_INSET,
  top: TOP - HATCH_INSET,
} as const

/** The outline the hatching fills, rounded like the cover. */
const HATCH_OUTLINE: Polyline = pipe(
  [
    [[HATCH_BOUNDS.left, HATCH_BOUNDS.bottom]],
    arc([HATCH_BOUNDS.right - HATCH_BOUNDS.corner, HATCH_BOUNDS.bottom + HATCH_BOUNDS.corner], HATCH_BOUNDS.corner, {
      from: ARC_DEGREES.down,
      to: ARC_DEGREES.right,
    }),
    arc([HATCH_BOUNDS.right - HATCH_BOUNDS.corner, HATCH_BOUNDS.top - HATCH_BOUNDS.corner], HATCH_BOUNDS.corner, {
      from: ARC_DEGREES.right,
      to: ARC_DEGREES.up,
    }),
    [
      [HATCH_BOUNDS.left, HATCH_BOUNDS.top],
      [HATCH_BOUNDS.left, HATCH_BOUNDS.bottom],
    ],
  ] satisfies ReadonlyArray<Polyline>,
  Arr.flatten,
  Arr.map(onCover),
)

// Lines at 45 degrees across the hatching's bounds, to be clipped to its outline.
const hatchLines = (): ReadonlyArray<Polyline> => {
  const { bottom, left, right } = HATCH_BOUNDS
  const lines: Array<Polyline> = []
  for (let offset = -HEIGHT; offset <= HEIGHT + WIDTH; offset += HATCH_SPACING) {
    lines.push([onCover([left, bottom + offset - (right - left)]), onCover([right, bottom + offset])])
  }
  return lines
}
const HATCH_LINES = hatchLines()

const SPARKLE_CUTOUTS: ReadonlyArray<Polyline> = pipe(SPARKLES, Arr.map(sparkleOutline), Arr.map(Arr.map(onCover)))

export { CENTER_LINES, HATCH_LINES, HATCH_OUTLINE, SPARKLE_CUTOUTS }
