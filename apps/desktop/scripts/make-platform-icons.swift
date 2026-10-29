// The Windows and Linux app icons, from the Mac's. Run through `bun run icons:platforms`;
// writes build/icon.ico and build/icons/<size>x<size>.png.
//
// The Mac icon is Apple's template: the tile inset in a transparent margin, with a drop shadow.
// Windows and Linux draw icons edge to edge, so the tile alone is cropped out (its opaque
// bounds) and scaled to each size. The .ico holds 16 to 256: the 256 as PNG, the smaller ones
// as 32-bit bitmaps, which every reader of icons (NSIS, Explorer) takes.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: make-platform-icons.swift <icon.png> <build dir>\n".data(using: .utf8)!)
  exit(2)
}
guard let base = NSImage(contentsOfFile: args[1]), let source = base.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
  exit(1)
}
let build = URL(fileURLWithPath: args[2])
let space = CGColorSpace(name: CGColorSpace.sRGB)!

/// RGBA pixels, premultiplied, top row first.
func pixels(of image: CGImage, size: Int) -> (CGContext, UnsafeMutablePointer<UInt8>) {
  let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4,
    space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
  )!
  ctx.interpolationQuality = .high
  return (ctx, ctx.data!.bindMemory(to: UInt8.self, capacity: size * size * 4))
}

// The tile: everything all but opaque. The shadow around it is faint, so it falls outside.
let full = source.width
let (sourceCtx, sourcePixels) = pixels(of: source, size: full)
defer { withExtendedLifetime(sourceCtx) {} }
sourceCtx.draw(source, in: CGRect(x: 0, y: 0, width: full, height: full))
var (minX, minY, maxX, maxY) = (full, full, -1, -1)
for y in 0..<full {
  for x in 0..<full where sourcePixels[(y * full + x) * 4 + 3] >= 250 {
    minX = min(minX, x); maxX = max(maxX, x)
    minY = min(minY, y); maxY = max(maxY, y)
  }
}
let side = max(maxX - minX, maxY - minY) + 1
let tile = source.cropping(to: CGRect(x: minX, y: minY, width: side, height: side))!

/// The tile at `size`: the context owns the pixels, so it's what's kept.
func render(_ size: Int) -> CGContext {
  let (ctx, _) = pixels(of: tile, size: size)
  ctx.draw(tile, in: CGRect(x: 0, y: 0, width: size, height: size))
  return ctx
}

func png(_ image: CGImage) -> Data {
  NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
}

let icons = build.appendingPathComponent("icons")
try? FileManager.default.createDirectory(at: icons, withIntermediateDirectories: true)
for size in [16, 32, 48, 64, 128, 256, 512] {
  try! png(render(size).makeImage()!).write(to: icons.appendingPathComponent("\(size)x\(size).png"))
}

/// A 32-bit bitmap as an .ico holds it: the header, BGRA rows bottom first with straight
/// alpha, then the 1-bit mask, all clear (the alpha decides).
func bitmap(_ size: Int) -> Data {
  let ctx = render(size)
  let rgba = ctx.data!.bindMemory(to: UInt8.self, capacity: size * size * 4)
  var out = Data()
  func le32(_ v: Int) { withUnsafeBytes(of: UInt32(truncatingIfNeeded: v).littleEndian) { out.append(contentsOf: $0) } }
  func le16(_ v: Int) { withUnsafeBytes(of: UInt16(truncatingIfNeeded: v).littleEndian) { out.append(contentsOf: $0) } }
  le32(40); le32(size); le32(size * 2); le16(1); le16(32); le32(0)
  le32(0); le32(0); le32(0); le32(0); le32(0)
  for row in (0..<size).reversed() {
    for x in 0..<size {
      let i = (row * size + x) * 4
      let a = Int(rgba[i + 3])
      let straight = { (c: UInt8) -> UInt8 in a == 0 ? 0 : UInt8(min(255, (Int(c) * 255 + a / 2) / a)) }
      out.append(contentsOf: [straight(rgba[i + 2]), straight(rgba[i + 1]), straight(rgba[i]), UInt8(a)])
    }
  }
  withExtendedLifetime(ctx) {}
  let maskRow = ((size + 31) / 32) * 4
  out.append(Data(count: maskRow * size))
  return out
}

let sizes = [16, 24, 32, 48, 64, 128, 256]
let images = sizes.map { $0 == 256 ? png(render(256).makeImage()!) : bitmap($0) }
var ico = Data()
func le16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { ico.append(contentsOf: $0) } }
func le32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { ico.append(contentsOf: $0) } }
le16(0); le16(1); le16(sizes.count)
var offset = 6 + 16 * sizes.count
for (size, image) in zip(sizes, images) {
  // A 256 is written as 0.
  ico.append(contentsOf: [UInt8(size % 256), UInt8(size % 256), 0, 0])
  le16(1); le16(32); le32(image.count); le32(offset)
  offset += image.count
}
for image in images { ico.append(image) }
try! ico.write(to: build.appendingPathComponent("icon.ico"))
