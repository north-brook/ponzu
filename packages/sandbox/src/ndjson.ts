/** The lines of a newline-delimited JSON body, parsed, however the bytes were split into chunks. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffered += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      // Without a newline after it, the last piece is a line still arriving, or the end.
      buffered = done ? "" : lines.pop()!;
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
      if (done) return;
    }
  } finally {
    // Reached when the consumer stops early too: let go of the connection.
    await reader.cancel().catch(() => {});
  }
}
