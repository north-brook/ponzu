import type { Api } from "@ponzu/client";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";

/** An image picked to go with a message, until it is uploaded to its canvas. */
export interface Picked {
  id: string;
  uri: string;
  name: string;
  type: string;
}

/**
 * Pictures from the photo library, up to `limit`, as JPEG rather than HEIC (what the API takes);
 * none when the person cancels or the library can't open. New canvas and the chat attach with it.
 */
export async function pickImages(already: number, limit = 6): Promise<Picked[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    preferredAssetRepresentationMode:
      ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
  }).catch(() => null);
  if (!result || result.canceled || !result.assets) return [];
  return result.assets.map((asset, i): Picked => {
    const type = asset.mimeType ?? "image/jpeg";
    const name = asset.fileName ?? `image-${already + i + 1}.jpg`;
    return {
      // Unique even when the same photo is attached twice, in one pick or two.
      id: `${asset.assetId ?? asset.uri}-${Crypto.randomUUID()}`,
      uri: asset.uri,
      // The library keeps a photo's own name ("IMG_0001.HEIC") on the JPEG it hands over: the
      // file goes up named for what it is, so the agent reads it as a JPEG.
      name: type === "image/jpeg" ? name.replace(/\.(heic|heif)$/i, ".jpg") : name,
      type,
    };
  });
}

/** Uploads picked images to a canvas: each one's ref, in order. Throws on a failure. */
export async function uploadImages(
  api: Pick<Api, "canvases">,
  canvasId: string,
  images: readonly Picked[],
): Promise<{ picked: Picked; ref: string }[]> {
  const uploaded = await Promise.all(
    images.map(async (image) => {
      const file = await api.canvases.upload(canvasId, {
        name: image.name,
        type: image.type,
        bytes: new Uint8Array(await new File(image.uri).arrayBuffer()),
      });
      return { picked: image, ref: file.ref };
    }),
  );
  return uploaded.filter((u): u is { picked: Picked; ref: string } => Boolean(u.ref));
}
