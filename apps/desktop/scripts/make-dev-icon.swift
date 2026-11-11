// Ponzu Dev's icon: the app icon with its yellow tile turned to a neutral grey, and nothing else
// changed, so it reads as Ponzu and is plainly not the release in the Dock, ⌘-Tab and Finder.
// Run through `bun run icons:dev`; writes build/dev/icon-1024.png (the script then makes
// icon.icns and the Linux sizes from it).
//
// The grey has the tile's luminance, so it is as light as the yellow and the slice keeps the
// same contrast against it. Every pixel of the icon is some of the tile's yellow, some of the
// slice's ink and some of the shadow's black (which adds nothing but alpha). Each pixel's share of
// yellow is solved for from its red and blue, and only that share is swapped for grey: the
// slice, the shadow and the margin come out exactly as they went in, and the antialiased edges
// stay true.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: make-dev-icon.swift <icon.png> <out.png>\n".data(using: .utf8)!)
  exit(2)
}
guard let base = NSImage(contentsOfFile: args[1]), let baseCG = base.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
  exit(1)
}

let size = baseCG.width // 1024 for the Big Sur template
let scale = Double(size) / 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(
  data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
ctx.draw(baseCG, in: CGRect(x: 0, y: 0, width: size, height: size))
let px = ctx.data!.bindMemory(to: UInt8.self, capacity: size * size * 4)

/// The colour at a point of the 1024pt template, top left origin.
func sample(_ x: Double, _ y: Double) -> [Double] {
  let i = (Int(y * scale) * size + Int(x * scale)) * 4
  return (0..<3).map { Double(px[i + $0]) }
}
// The tile is the template's 824pt square at (100, 100); the slice's segments start 283pt down.
// Above the slice is all tile; the middle of the left segment is all ink.
let tile = sample(512, 170)
let ink = sample(360, 512)

func linear(_ c: Double) -> Double {
  let v = c / 255
  return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
}
func encoded(_ v: Double) -> Double {
  let c = v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1 / 2.4) - 0.055
  return (c * 255).rounded()
}
let luminance = 0.2126 * linear(tile[0]) + 0.7152 * linear(tile[1]) + 0.0722 * linear(tile[2])
let grey = encoded(luminance)

// Each pixel's red and blue are yellow × a + ink × k (premultiplied; the shadow's black adds
// nothing). Solved for a, the pixel's share of yellow; green then checks the icon is only these.
let det = tile[0] * ink[2] - ink[0] * tile[2]
guard abs(det) > 1 else {
  FileHandle.standardError.write("the tile and the slice aren't the colours this expects\n".data(using: .utf8)!)
  exit(1)
}
var worst = 0.0
for p in 0..<(size * size) {
  let i = p * 4
  let r = Double(px[i]), g = Double(px[i + 1]), b = Double(px[i + 2])
  let a = (r * ink[2] - ink[0] * b) / det
  let k = (tile[0] * b - r * tile[2]) / det
  worst = max(worst, abs(tile[1] * a + ink[1] * k - g))
  guard a > 0 else { continue }
  for c in 0..<3 {
    px[i + c] = UInt8(max(0, min(255, (Double(px[i + c]) + a * (grey - tile[c])).rounded())))
  }
}
// A pixel off by more than rounding means a colour this doesn't know of (a highlight, a
// gradient): stop rather than make an icon that isn't the release's.
guard worst <= 4 else {
  FileHandle.standardError.write("the icon has colours other than the tile, the slice and the shadow (off by \(worst))\n".data(using: .utf8)!)
  exit(1)
}
print("tile \(tile.map { Int($0) }) → grey \(Int(grey)); slice \(ink.map { Int($0) }) kept")

let out = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: out)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: args[2]))
