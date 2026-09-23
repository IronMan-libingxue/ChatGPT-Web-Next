import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOGO_ID, LOGO_CHOICES } from '../src/main/preferences-store'

interface DecodedPng {
  width: number
  height: number
  pixels: Buffer
}

const projectRoot = resolve(import.meta.dirname, '..')
const iconFixtures = [
  { id: 'logo-043714', width: 1254, height: 1254, sha256: '5a7f9c8c6fd1c0f0df818fdbb418deb3dc41076368406f5c249b067ab5b688c7' },
  { id: 'logo-121805', width: 1254, height: 1254, sha256: '268bb64fd398729551a3d2489c7cc08faa781b50c2b988aba76e897c268fdf16' },
  { id: 'logo-122825', width: 1254, height: 1254, sha256: '03ce4ffc0c66c8ada97b6cdf265bbfbd0c0e781691554d2fcedade6725d6f501' },
  { id: 'logo-123336', width: 1254, height: 1254, sha256: '53fef856cc668d0d80f02bbad6c533c25b3892fbfcb0a734537392dfec397b07' },
  { id: 'logo-124106', width: 1278, height: 1278, sha256: '0efc9047f5f4209f9cfdd277fbe6e34dcb9f38bcfadb5190f0318efabd062af2' }
] as const

describe('bundled icon assets', () => {
  it('bundles exactly the five approved assets and keeps their renderer copies identical', async () => {
    expect(DEFAULT_LOGO_ID).toBe('logo-121805')
    expect(LOGO_CHOICES.map((choice) => choice.id)).toEqual(iconFixtures.map((icon) => icon.id))

    for (const fixture of iconFixtures) {
      const resource = await readFile(resolve(projectRoot, 'resources/icons', `${fixture.id}.png`))
      const renderer = await readFile(resolve(projectRoot, 'src/renderer/src/assets', `${fixture.id}.png`))
      const header = readPngHeader(resource)
      expect(hash(resource), fixture.id).toBe(fixture.sha256)
      expect(hash(renderer), fixture.id).toBe(fixture.sha256)
      expect([header.width, header.height], fixture.id).toEqual([fixture.width, fixture.height])
      expect(header.format, fixture.id).toEqual([8, 6, 0, 0, 0])
    }
  })

  it('keeps the non-square fifth source pixel-perfect and adds only transparent padding', async () => {
    const encoded = await readFile(resolve(projectRoot, 'resources/icons/logo-124106.png'))
    const decoded = decodeRgbaPng(encoded)
    const sourceHeight = 1230
    const topPadding = 24
    const rowBytes = decoded.width * 4
    const top = decoded.pixels.subarray(0, topPadding * rowBytes)
    const source = decoded.pixels.subarray(topPadding * rowBytes, (topPadding + sourceHeight) * rowBytes)
    const bottom = decoded.pixels.subarray((topPadding + sourceHeight) * rowBytes)

    expect(top.every((value) => value === 0)).toBe(true)
    expect(bottom.every((value) => value === 0)).toBe(true)
    expect(hash(extractAlpha(source))).toBe('a2088ee33ed3de9740ab979ff6a3f54474aadfd9b7ea4c7ea75d7c551b4b0015')
  })

  it('uses a square transparent default build icon', async () => {
    const buildIcon = decodeRgbaPng(await readFile(resolve(projectRoot, 'build/icon.png')))
    expect([buildIcon.width, buildIcon.height]).toEqual([1024, 1024])
    expect(hasVisibleAndTransparentPixels(buildIcon.pixels)).toBe(true)
  })
})

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function hasVisibleAndTransparentPixels(pixels: Uint8Array): boolean {
  let transparent = false
  let visible = false
  for (let index = 3; index < pixels.length; index += 4) {
    const alpha = pixels[index] ?? 0
    transparent ||= alpha === 0
    visible ||= alpha > 0
    if (transparent && visible) return true
  }
  return false
}

function extractAlpha(pixels: Uint8Array): Buffer {
  const alpha = Buffer.alloc(pixels.length / 4)
  for (let source = 3, target = 0; source < pixels.length; source += 4, target += 1) {
    alpha[target] = pixels[source] ?? 0
  }
  return alpha
}

function readPngHeader(encoded: Buffer): { width: number; height: number; format: number[] } {
  expect(encoded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  expect(encoded.toString('ascii', 12, 16)).toBe('IHDR')
  return {
    width: encoded.readUInt32BE(16),
    height: encoded.readUInt32BE(20),
    format: [...encoded.subarray(24, 29)]
  }
}

function decodeRgbaPng(encoded: Buffer): DecodedPng {
  expect(encoded.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  let offset = 8
  let width = 0
  let height = 0
  const compressed: Buffer[] = []
  while (offset < encoded.length) {
    const length = encoded.readUInt32BE(offset)
    const type = encoded.toString('ascii', offset + 4, offset + 8)
    const data = encoded.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      expect([...data.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0])
    } else if (type === 'IDAT') {
      compressed.push(data)
    }
    offset += length + 12
    if (type === 'IEND') break
  }

  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const filtered = inflateSync(Buffer.concat(compressed))
  expect(filtered.length).toBe((stride + 1) * height)
  const pixels = Buffer.alloc(stride * height)
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[row * (stride + 1)] ?? -1
    const inputStart = row * (stride + 1) + 1
    const outputStart = row * stride
    for (let column = 0; column < stride; column += 1) {
      const raw = filtered[inputStart + column] ?? 0
      const left = column >= bytesPerPixel ? (pixels[outputStart + column - bytesPerPixel] ?? 0) : 0
      const above = row > 0 ? (pixels[outputStart + column - stride] ?? 0) : 0
      const upperLeft = row > 0 && column >= bytesPerPixel
        ? (pixels[outputStart + column - stride - bytesPerPixel] ?? 0)
        : 0
      const predictor: number = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? above
            : filter === 3
              ? Math.floor((left + above) / 2)
              : filter === 4
                ? paeth(left, above, upperLeft)
                : Number.NaN
      if (!Number.isFinite(predictor)) throw new Error(`Unsupported PNG filter ${filter}`)
      pixels[outputStart + column] = (raw + predictor) & 0xff
    }
  }
  return { width, height, pixels }
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft
  const leftDistance = Math.abs(estimate - left)
  const aboveDistance = Math.abs(estimate - above)
  const upperLeftDistance = Math.abs(estimate - upperLeft)
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left
  if (aboveDistance <= upperLeftDistance) return above
  return upperLeft
}
