/**
 * An asset response that honors a Range header. Chromium only seeks a video
 * it can fetch in ranges, so without this a render can't step through one.
 * One range is enough for media; several, or one we can't read, get the whole body.
 */
export function assetResponse(blob: Blob, type: string, range: string | null): Response {
  const headers = { "content-type": type, "cache-control": "no-cache", "accept-ranges": "bytes" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? "");
  if (!m || (!m[1] && !m[2])) return new Response(blob, { headers });
  const size = blob.size;
  // bytes=-n is the last n bytes; bytes=a- runs to the end.
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start || (!m[1] && Number(m[2]) === 0))
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}` },
  });
}
