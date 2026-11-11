// Marks the app icon as Ponzu Preview's: a PREVIEW band in the site's near-black ink across the
// foot of the yellow tile, under the slice, so it reads as Ponzu and is plainly not the release
// in the Dock, ⌘-Tab and Finder. Run through `bun run icons:preview`; writes
// build/preview/icon-1024.png (the script then makes icon.icns and the Linux sizes from it).
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: make-preview-icon.swift <icon.png> <out.png>\n".data(using: .utf8)!)
  exit(2)
}
guard let base = NSImage(contentsOfFile: args[1]), let baseCG = base.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("cannot read \(args[1])\n".data(using: .utf8)!)
  exit(1)
}

let size = CGFloat(baseCG.width) // 1024 for the Big Sur template
let scale = size / 1024
let space = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(
  data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
  space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
)!
ctx.draw(baseCG, in: CGRect(x: 0, y: 0, width: size, height: size))

// The tile is the template's 824pt square at (100, 100) with a 185pt corner radius. The band is
// a pill between the slice (which ends 740pt from the top) and the tile's foot (924pt).
let ink = CGColor(srgbRed: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255, alpha: 1)
let band = CGRect(x: 332 * scale, y: (1024 - 870) * scale, width: 360 * scale, height: 82 * scale)
ctx.setFillColor(ink)
ctx.addPath(CGPath(roundedRect: band, cornerWidth: band.height / 2, cornerHeight: band.height / 2, transform: nil))
ctx.fillPath()

// PREVIEW, in the system's heavy face, tracked out a little, in the tile's own yellow.
let yellow = NSColor(srgbRed: 0xfc / 255, green: 0xc8 / 255, blue: 0x1e / 255, alpha: 1)
let font = NSFont.systemFont(ofSize: 50 * scale, weight: .heavy)
let text = NSAttributedString(string: "PREVIEW", attributes: [
  .font: font,
  .foregroundColor: yellow,
  .kern: 5 * scale,
])
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
let bounds = text.boundingRect(with: CGSize(width: band.width, height: band.height), options: [.usesLineFragmentOrigin])
// The trailing kern adds space after the last letter; centre the letters themselves.
let width = bounds.width - 5 * scale
// Drawn from the line's bottom left, which sits a descender below the baseline: the capitals
// are centred in the band.
let baseline = band.midY - font.capHeight / 2
text.draw(at: CGPoint(x: band.midX - width / 2, y: baseline + font.descender))
NSGraphicsContext.restoreGraphicsState()

let out = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: out)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: args[2]))
