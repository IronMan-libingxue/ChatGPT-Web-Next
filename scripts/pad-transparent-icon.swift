import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("usage: pad-transparent-icon.swift <input.png> <output.png>\n", stderr)
  exit(2)
}

let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
guard
  let source = NSImage(contentsOf: input),
  let sourceRepresentation = source.representations.first
else {
  fputs("cannot read input image\n", stderr)
  exit(1)
}

let sourceWidth = sourceRepresentation.pixelsWide
let sourceHeight = sourceRepresentation.pixelsHigh
let canvasSize = max(sourceWidth, sourceHeight)
guard let bitmap = NSBitmapImageRep(
  bitmapDataPlanes: nil,
  pixelsWide: canvasSize,
  pixelsHigh: canvasSize,
  bitsPerSample: 8,
  samplesPerPixel: 4,
  hasAlpha: true,
  isPlanar: false,
  colorSpaceName: .deviceRGB,
  bytesPerRow: 0,
  bitsPerPixel: 0
) else {
  fputs("cannot allocate output image\n", stderr)
  exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSColor.clear.setFill()
NSBezierPath(rect: NSRect(x: 0, y: 0, width: canvasSize, height: canvasSize)).fill()
source.draw(
  in: NSRect(
    x: (canvasSize - sourceWidth) / 2,
    y: (canvasSize - sourceHeight) / 2,
    width: sourceWidth,
    height: sourceHeight
  ),
  from: .zero,
  operation: .sourceOver,
  fraction: 1,
  respectFlipped: true,
  hints: [.interpolation: NSImageInterpolation.none]
)
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
  fputs("cannot encode output image\n", stderr)
  exit(1)
}
try png.write(to: output, options: .atomic)
