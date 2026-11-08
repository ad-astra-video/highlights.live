// ADAAAA-8377 (LFR-1): the REAL pixel dimensions of a rail JPEG.
//
// The live rail used to hardcode `scale=320:180` while VOD ran 640:360, and
// nothing on a decide row said which one a payload was built from — the image
// budget (`imagesPerDecide` / `imageBudgetApplied`) says how MANY images a call
// carried, never how big they were. LFR-1 makes the scale a knob
// (`LIVE_FRAME_SCALE`) and requires the ON leg to prove its images are 640x360,
// so every decide row now carries the dims the call actually shipped.
//
// Reading them off the frame bytes (rather than echoing the configured string)
// is deliberate: the AC grades the images gemma received. If a future change
// resizes between the rail and the payload, the row reports the payload's true
// dims instead of a config value that would have hidden it.

/** A decoded JPEG frame's pixel dimensions. */
export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parse a JPEG's SOF (start-of-frame) header for its width/height.
 *
 * Scans the marker chain from SOI: every segment is `0xFF <marker> <len:u16>`
 * followed by `len - 2` payload bytes; the first SOF0..SOF15 **except** DHT
 * (0xC4), JPG (0xC8) and DAC (0xCC) carries `[precision:u8][height:u16]
 * [width:u16]` after its length field. Standalone markers (RSTn, TEM, and the
 * SOI/EOI pair) have no length, so they are skipped explicitly.
 *
 * Returns `undefined` for anything that is not a JPEG or has no SOF inside the
 * scanned bounds — an unreadable frame must leave the keys OFF the audit row
 * rather than fabricate dims.
 */
export function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 3 < bytes.length) {
    // Markers are preceded by 0xFF; resync past fill bytes (0xFF padding).
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    // Skip any 0xFF fill bytes before the marker id.
    let j = i + 1;
    while (j < bytes.length && bytes[j] === 0xff) j += 1;
    const marker = bytes[j];
    if (marker === undefined) return undefined;
    const seg = j + 1;
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i = seg;
      continue;
    }
    if (seg + 1 >= bytes.length) return undefined;
    const len = (bytes[seg] << 8) | bytes[seg + 1];
    if (len < 2) return undefined;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // [len:u16][precision:u8][height:u16][width:u16]
      const heightAt = seg + 3;
      const widthAt = seg + 5;
      if (widthAt + 1 >= bytes.length) return undefined;
      const height = (bytes[heightAt] << 8) | bytes[heightAt + 1];
      const width = (bytes[widthAt] << 8) | bytes[widthAt + 1];
      if (width > 0 && height > 0) return { width, height };
      return undefined;
    }
    i = seg + len;
  }
  return undefined;
}

/** Convenience: dims of a base64 JPEG payload (`undefined` when unreadable). */
export function jpegDimensionsFromBase64(b64: string | undefined | null): ImageDimensions | undefined {
  if (!b64) return undefined;
  // A `data:` prefix is tolerated; the decide payloads carry bare base64.
  const comma = b64.startsWith("data:") ? b64.indexOf(",") : -1;
  const raw = comma >= 0 ? b64.slice(comma + 1) : b64;
  if (!raw) return undefined;
  try {
    return jpegDimensions(Buffer.from(raw, "base64"));
  } catch {
    return undefined;
  }
}
