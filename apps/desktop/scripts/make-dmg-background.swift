// Draws the disk image's window background: a faint warm ground, a rind arrow from
// where the app sits to where Applications sits, and one line saying what to do.
// Writes build/background.png and build/background@2x.png, which electron-builder
// joins into the DMG's background. The icon centres here must match dmg.contents
// in package.json. Run from apps/desktop: swift scripts/make-dmg-background.swift
import AppKit

/// Finder's content area for the disk image, in points.
let width: CGFloat = 540
let height: CGFloat = 380
/// Icon centres in Finder's coordinates (y down), as in dmg.contents.
let app = CGPoint(x: 130, y: 124)
let applications = CGPoint(x: 410, y: 124)
let iconSize: CGFloat = 80

let rind = CGColor(srgbRed: 0xf4 / 255, green: 0xb0 / 255, blue: 0x12 / 255, alpha: 1)
let ink = NSColor(srgbRed: 0x7a / 255, green: 0x6a / 255, blue: 0x45 / 255, alpha: 1)
let top = CGColor(srgbRed: 0xfd / 255, green: 0xfc / 255, blue: 0xf9 / 255, alpha: 1)
let bottom = CGColor(srgbRed: 0xfb / 255, green: 0xf8 / 255, blue: 0xf0 / 255, alpha: 1)

func draw(scale: CGFloat, to path: String) {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(
    data: nil, width: Int(width * scale), height: Int(height * scale), bitsPerComponent: 8,
    bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // Flip so coordinates read like Finder's: y grows downward.
  ctx.translateBy(x: 0, y: height * scale)
  ctx.scaleBy(x: scale, y: -scale)

  let ground = CGGradient(colorsSpace: space, colors: [top, bottom] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(
    ground, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: height), options: [])

  // The arrow runs between the icons with room either side.
  let gap: CGFloat = 36
  let x0 = app.x + iconSize / 2 + gap
  let x1 = applications.x - iconSize / 2 - gap
  ctx.setStrokeColor(rind)
  ctx.setLineWidth(3)
  ctx.setLineCap(.round)
  ctx.setLineJoin(.round)
  ctx.move(to: CGPoint(x: x0, y: app.y))
  ctx.addLine(to: CGPoint(x: x1, y: app.y))
  ctx.move(to: CGPoint(x: x1 - 12, y: app.y - 10))
  ctx.addLine(to: CGPoint(x: x1, y: app.y))
  ctx.addLine(to: CGPoint(x: x1 - 12, y: app.y + 10))
  ctx.strokePath()

  // Below the icons' labels, above the status bar Finder draws over the bottom.
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
  let text = "Drag Ponzu into Applications, then open it from there." as NSString
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 13),
    .foregroundColor: ink,
  ]
  let size = text.size(withAttributes: attrs)
  text.draw(at: NSPoint(x: (width - size.width) / 2, y: 268), withAttributes: attrs)
  NSGraphicsContext.restoreGraphicsState()

  let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

draw(scale: 1, to: "build/background.png")
draw(scale: 2, to: "build/background@2x.png")
