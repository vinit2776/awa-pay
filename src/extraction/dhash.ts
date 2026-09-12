import sharp from "sharp";

// A standard difference-hash: shrink to a tiny 9x8 grayscale grid, then
// record whether each pixel is brighter than its right-hand neighbor — 8
// rows of 8 comparisons is 64 bits, written out as 16 hex characters.
// Images that look alike (a re-photograph, a crop, a rotation the resize
// mostly erases) hash the same or very close; this is the "Strong, not
// Decisive" signal the brief describes — stored on request_file.phash,
// not yet wired into duplicate detection this phase (docs/START-HERE-
// slice-4.md).
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

export async function computeDHash(imageBytes: Buffer): Promise<string> {
  const { data } = await sharp(imageBytes)
    .resize(HASH_WIDTH, HASH_HEIGHT, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = "";
  for (let row = 0; row < HASH_HEIGHT; row++) {
    for (let col = 0; col < HASH_WIDTH - 1; col++) {
      const left = data[row * HASH_WIDTH + col];
      const right = data[row * HASH_WIDTH + col + 1];
      bits += left > right ? "1" : "0";
    }
  }

  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
