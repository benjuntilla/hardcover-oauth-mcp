/** PNG rendering with resvg, and ICO files built from PNGs. */
import { Array as Arr, pipe } from "effect"
import { Resvg } from "@resvg/resvg-js"

interface IcoImage {
  readonly png: Uint8Array
  readonly size: number
}

/** Byte offsets of the fields an ICO file needs, in its header and in each image's directory entry. */
const HEADER = { bytes: 6, count: 4, type: 2 } as const
const ENTRY = { bitCount: 6, bytes: 16, height: 1, length: 8, offset: 12, planes: 4, width: 0 } as const
const ICON_TYPE = 1
const PLANES = 1
const BITS_PER_PIXEL = 32
const LITTLE_ENDIAN = true

/**
 * An SVG rendered to PNG.
 * @param {object} options The SVG and how to render it.
 * @param {ReadonlyArray<string>} options.fontFiles TrueType or OpenType files for the SVG's text.
 * @param {string} options.svg The SVG document.
 * @param {number} options.width The PNG's width in pixels.
 * @returns {Uint8Array} The PNG.
 */
const png = (options: { readonly fontFiles: ReadonlyArray<string>; readonly svg: string; readonly width: number }): Uint8Array =>
  new Resvg(options.svg, {
    fitTo: { mode: "width", value: options.width },
    font: { fontFiles: Arr.copy(options.fontFiles), loadSystemFonts: false },
  })
    .render()
    .asPng()

// Fields left unset, the reserved bytes and the palette size of true-color images, stay zero.
const header = (count: number): Uint8Array => {
  const view = new DataView(new ArrayBuffer(HEADER.bytes))
  view.setUint16(HEADER.type, ICON_TYPE, LITTLE_ENDIAN)
  view.setUint16(HEADER.count, count, LITTLE_ENDIAN)
  return new Uint8Array(view.buffer)
}

const entry = (image: IcoImage, offset: number): Uint8Array => {
  const view = new DataView(new ArrayBuffer(ENTRY.bytes))
  view.setUint8(ENTRY.width, image.size)
  view.setUint8(ENTRY.height, image.size)
  view.setUint16(ENTRY.planes, PLANES, LITTLE_ENDIAN)
  view.setUint16(ENTRY.bitCount, BITS_PER_PIXEL, LITTLE_ENDIAN)
  view.setUint32(ENTRY.length, image.png.byteLength, LITTLE_ENDIAN)
  view.setUint32(ENTRY.offset, offset, LITTLE_ENDIAN)
  return new Uint8Array(view.buffer)
}

/**
 * An ICO file holding PNGs, which every current browser reads.
 * @param {ReadonlyArray<IcoImage>} images Square images, each under 256 pixels.
 * @returns {Uint8Array} The ICO file.
 */
const ico = (images: ReadonlyArray<IcoImage>): Uint8Array => {
  const offsets = Arr.scan(images, HEADER.bytes + ENTRY.bytes * images.length, (offset, image) => offset + image.png.byteLength)
  const entries = pipe(
    Arr.zip(images, offsets),
    Arr.map(([image, offset]) => entry(image, offset)),
  )
  const pngs = pipe(
    images,
    Arr.map((image) => image.png),
  )
  return new Uint8Array(Bun.concatArrayBuffers([header(images.length), ...entries, ...pngs]))
}

export { ico, png }
