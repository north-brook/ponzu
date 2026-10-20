// Finder's icon for a .design: the canvas preview Ponzu keeps at
// .ponzu/preview.png. Without one, Finder falls back to the document icon.
// Built and embedded by scripts/quicklook.mjs.
import Foundation
import QuickLookThumbnailing

final class ThumbnailProvider: QLThumbnailProvider {
  override func provideThumbnail(
    for request: QLFileThumbnailRequest,
    _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
  ) {
    let preview = request.fileURL.appendingPathComponent(".ponzu/preview.png")
    guard FileManager.default.isReadableFile(atPath: preview.path) else {
      handler(nil, CocoaError(.fileReadNoSuchFile))
      return
    }
    handler(QLThumbnailReply(imageFileURL: preview), nil)
  }
}
