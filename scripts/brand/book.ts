/**
 * The book from Hardcover's logo as a solid: two covers rounded at their outer corners, a spine, and the pages, with
 * two sparkles on the front cover. Points reach the page through an oblique projection, tilted counterclockwise.
 */
import { Array as Arr, pipe } from "effect"
import { BoxGeometry, ExtrudeGeometry, MathUtils, Shape } from "three"
import type { BufferGeometry } from "three"

type Point = readonly [number, number]
type Point3 = readonly [number, number, number]
type Polyline = ReadonlyArray<Point>

/** A four-pointed star on the front cover, by its center and half-extents. */
interface Sparkle {
  readonly cx: number
  readonly cy: number
  readonly halfHeight: number
  readonly halfWidth: number
}

const HALF = 0.5
const UNMOVED = 0

// The book's size in drawing units. The dimensions label each at ten times its value, in millimetres.
const WIDTH = 18
const HEIGHT = 24
const THICKNESS = 7
const COVER = 0.35
/** How far the covers stand out past the pages. */
const OVERHANG = 0.6
/** The radius of the covers' two outer corners. */
const RADIUS = 2.4
const RIGHT = WIDTH * HALF
const TOP = HEIGHT * HALF
const FRONT = THICKNESS * HALF

const PAGES = {
  back: -FRONT + COVER,
  bottom: -TOP + OVERHANG,
  front: FRONT - COVER,
  left: -RIGHT + COVER,
  right: RIGHT - OVERHANG,
  top: TOP - OVERHANG,
} as const

const SPARKLES: ReadonlyArray<Sparkle> = [
  { cx: -0.6, cy: -1.6, halfHeight: 4.4, halfWidth: 3.5 },
  { cx: 3.6, cy: 5.4, halfHeight: 2.1, halfWidth: 1.75 },
]
/** Where each side's control point sits between the sparkle's center (0) and its tips (1); lower is pointier. */
const SPARKLE_PINCH = 0.24
const SPARKLE_POINTS = 48

// Each unit of depth shifts a point this far right and up on the page, then the whole drawing turns counterclockwise.
const OBLIQUE_RIGHT = 0.3
const OBLIQUE_UP = 0.75
const TILT_DEGREES = 15
const TILT = MathUtils.degToRad(TILT_DEGREES)
const COS_TILT = Math.cos(TILT)
const SIN_TILT = Math.sin(TILT)

const ANGLE_RIGHT = 0
const ANGLE_UP = Math.PI * HALF
const ANGLE_DOWN = -ANGLE_UP
const ARC_SEGMENTS = 24

/**
 * Where a point in the book's space lands on the page.
 * @param {Point3} point The point, in drawing units from the book's center.
 * @returns {Point} Its position on the page, in drawing units.
 */
const screen = ([px, py, pz]: Point3): Point => {
  const across = px + pz * OBLIQUE_RIGHT
  const up = py + pz * OBLIQUE_UP
  return [across * COS_TILT - up * SIN_TILT, across * SIN_TILT + up * COS_TILT]
}

/**
 * Where a point on the front cover lands on the page.
 * @param {Point} point The point, in drawing units from the cover's center.
 * @returns {Point} Its position on the page, in drawing units.
 */
const onCover = ([px, py]: Point): Point => screen([px, py, FRONT])

/**
 * Where a point on the back cover's outer face lands on the page.
 * @param {Point} point The point, in drawing units from the cover's center.
 * @returns {Point} Its position on the page, in drawing units.
 */
const onBack = ([px, py]: Point): Point => screen([px, py, -FRONT])

const coverShape = (): Shape =>
  new Shape()
    .moveTo(-RIGHT, -TOP)
    .lineTo(RIGHT - RADIUS, -TOP)
    .absarc(RIGHT - RADIUS, -TOP + RADIUS, RADIUS, ANGLE_DOWN, ANGLE_RIGHT, false)
    .lineTo(RIGHT, TOP - RADIUS)
    .absarc(RIGHT - RADIUS, TOP - RADIUS, RADIUS, ANGLE_RIGHT, ANGLE_UP, false)
    .lineTo(-RIGHT, TOP)
    .lineTo(-RIGHT, -TOP)

const sparkleShape = ({ cx, cy, halfHeight, halfWidth }: Sparkle): Shape => {
  const pinchX = halfWidth * SPARKLE_PINCH
  const pinchY = halfHeight * SPARKLE_PINCH
  return new Shape()
    .moveTo(cx, cy + halfHeight)
    .quadraticCurveTo(cx + pinchX, cy + pinchY, cx + halfWidth, cy)
    .quadraticCurveTo(cx + pinchX, cy - pinchY, cx, cy - halfHeight)
    .quadraticCurveTo(cx - pinchX, cy - pinchY, cx - halfWidth, cy)
    .quadraticCurveTo(cx - pinchX, cy + pinchY, cx, cy + halfHeight)
}

/**
 * A sparkle's outline on the front cover.
 * @param {Sparkle} sparkle The sparkle.
 * @returns {Polyline} Its outline, in drawing units from the cover's center.
 */
const sparkleOutline = (sparkle: Sparkle): Polyline =>
  pipe(
    sparkleShape(sparkle).getPoints(SPARKLE_POINTS),
    Arr.map((point): Point => [point.x, point.y]),
  )

const cover = (back: number): BufferGeometry =>
  new ExtrudeGeometry(coverShape(), { bevelEnabled: false, curveSegments: ARC_SEGMENTS, depth: COVER }).translate(UNMOVED, UNMOVED, back)

const box = (corners: { readonly max: Point3; readonly min: Point3 }): BufferGeometry => {
  const [minX, minY, minZ] = corners.min
  const [maxX, maxY, maxZ] = corners.max
  return new BoxGeometry(maxX - minX, maxY - minY, maxZ - minZ).translate((minX + maxX) * HALF, (minY + maxY) * HALF, (minZ + maxZ) * HALF)
}

/** The covers, the spine, and the pages. */
const SOLIDS: ReadonlyArray<BufferGeometry> = [
  cover(FRONT - COVER),
  cover(-FRONT),
  box({ max: [-RIGHT + COVER, TOP, PAGES.front], min: [-RIGHT, -TOP, PAGES.back] }),
  box({ max: [PAGES.right, PAGES.top, PAGES.front], min: [PAGES.left, PAGES.bottom, PAGES.back] }),
]

export {
  FRONT,
  HEIGHT,
  OBLIQUE_RIGHT,
  OBLIQUE_UP,
  PAGES,
  RADIUS,
  RIGHT,
  SOLIDS,
  SPARKLES,
  THICKNESS,
  TOP,
  WIDTH,
  onBack,
  onCover,
  screen,
  sparkleOutline,
}
export type { Point, Point3, Polyline }
