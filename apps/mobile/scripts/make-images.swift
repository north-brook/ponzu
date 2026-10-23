// Draws the phone's icon from the slice (lib/mark.ts). The native splash is
// yuzu alone (app.json), and the launch screen blooms the slice in on it.
// macOS only (AppKit renders the SVG). Rerun when the mark changes:
//
//   swift apps/mobile/scripts/make-images.swift apps/mobile/assets
//
// icon.png: the brand's app icon (design/brand.design, logo 05) made for
// iOS, which masks the corners itself and refuses transparency: a full-bleed
// flat yuzu square, the ink slice 56% of its width, opaque.

import AppKit

let out = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let slice = [
  "M36 25.07L36 4.99A27.3 27.3 0 0 1 53.39 15.03Z",
  "M40 32L57.39 21.96A27.3 27.3 0 0 1 57.39 42.04Z",
  "M36 38.93L53.39 48.97A27.3 27.3 0 0 1 36 59.01Z",
  "M28 38.93L28 59.01A27.3 27.3 0 0 1 10.61 48.97Z",
  "M24 32L6.61 42.04A27.3 27.3 0 0 1 6.61 21.96Z",
  "M28 25.07L10.61 15.03A27.3 27.3 0 0 1 28 4.99Z",
]
let yuzu = "#ffc81e"
let ink = "#111110"
// The slice's drawn width on its 64 grid: the arcs reach 6.61 and 57.39,
// and the 3.4 stroke adds half its width on each side.
let drawn = 57.39 - 6.61 + 3.4

func paths() -> String {
  slice.map { "<path d=\"\($0)\"/>" }.joined()
}

/// Renders `svg` at `width`×`height` pixels; `opaque` writes no alpha channel.
func render(_ svg: String, width: Int, height: Int, opaque: Bool, to name: String) {
  guard let image = NSImage(data: Data(svg.utf8)) else { fatalError("bad svg for \(name)") }
  let alpha: CGImageAlphaInfo = opaque ? .noneSkipLast : .premultipliedLast
  let context = CGContext(
    data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: alpha.rawValue)!
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
  NSGraphicsContext.restoreGraphicsState()
  let url = out.appendingPathComponent(name) as CFURL
  let dest = CGImageDestinationCreateWithURL(url, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, context.makeImage()!, nil)
  CGImageDestinationFinalize(dest)
  print("wrote \(name) \(width)x\(height)")
}

// Icon: the visible slice is 56% of the tile, centred. iconBox is the
// viewBox side that makes the drawn slice that share of it.
let iconBox = 64 / (0.56 * 64 / drawn)
let pad = (iconBox - 64) / 2
render(
  """
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="\(-pad) \(-pad) \(iconBox) \(iconBox)">
  <rect x="\(-pad)" y="\(-pad)" width="\(iconBox)" height="\(iconBox)" fill="\(yuzu)"/>
  <g fill="\(ink)" stroke="\(ink)" stroke-width="3.4" stroke-linejoin="round">\(paths())</g>
  </svg>
  """, width: 1024, height: 1024, opaque: true, to: "icon.png")
