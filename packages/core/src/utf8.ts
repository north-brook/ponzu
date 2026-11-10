/** The length of a string in UTF-8 bytes, without building the bytes. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    // A surrogate pair is four bytes, counted as two for each half.
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
