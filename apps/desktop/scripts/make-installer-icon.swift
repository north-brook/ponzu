// Composites an install badge onto the app icon so the mounted disk image is
// visibly not the app. Run through `bun run icons:installer`; writes
// build/installer-icon.png and build/installer-icon.icns.
import AppKit

let args = CommandLine.arguments
guard args.count == 3 else {
  FileHandle.standardError.write("usage: make-installer-icon.swift <icon.png> <out.png>\n".data(using: .utf8)!)
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

// Badge in the tile's bottom-right corner (CoreGraphics is y-up), in the
// site's near-black ink. Its white ring sets it off the dark tile.
let ink = CGColor(srgbRed: 0x0e / 255, green: 0x0e / 255, blue: 0x0e / 255, alpha: 1)
let center = CGPoint(x: 736 * scale, y: (1024 - 736) * scale)
let radius = 138 * scale

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -6 * scale), blur: 24 * scale, color: CGColor(gray: 0, alpha: 0.28))
ctx.setFillColor(CGColor(gray: 1, alpha: 1))
ctx.fillEllipse(in: CGRect(x: center.x - radius - 22 * scale, y: center.y - radius - 22 * scale, width: (radius + 22 * scale) * 2, height: (radius + 22 * scale) * 2))
ctx.restoreGState()
ctx.setFillColor(ink)
ctx.fillEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))

// Down arrow into a tray.
ctx.setStrokeColor(CGColor(gray: 1, alpha: 1))
ctx.setLineWidth(24 * scale)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
let shaft = 104 * scale
let head = 48 * scale
let top = center.y + 72 * scale
ctx.move(to: CGPoint(x: center.x, y: top))
ctx.addLine(to: CGPoint(x: center.x, y: top - shaft))
ctx.move(to: CGPoint(x: center.x - head, y: top - shaft + head))
ctx.addLine(to: CGPoint(x: center.x, y: top - shaft))
ctx.addLine(to: CGPoint(x: center.x + head, y: top - shaft + head))
let tray = top - shaft - 40 * scale
ctx.move(to: CGPoint(x: center.x - 70 * scale, y: tray))
ctx.addLine(to: CGPoint(x: center.x + 70 * scale, y: tray))
ctx.strokePath()

let out = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: out)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: args[2]))
