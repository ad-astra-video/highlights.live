// Minimal STORE-only ZIP writer for the client-side batch export
// (ADAAAA-7622). The webapp has no zip dependency, so a highlight batch
// export ("select N clips -> one download") needs the archive built in the
// browser. Every clip is an already-compressed H.264/AAC MP4, so `method: 0`
// (store) is both correct and cheap: no deflate pass, no extra CPU on the
// request that is about to hit the network anyway.
//
// Deliberately dependency-free + deterministic (fixed DOS timestamp) so the
// bytes are unit-testable: the tests parse the archive back and check each
// entry's name, size and CRC.

export interface ZipFile {
  /** Entry name (relative, forward slashes — no leading slash). */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (IEEE 802.3), the checksum a ZIP entry stores. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = (CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date 1980-01-01 (the ZIP epoch) — keeps the archive bytes deterministic. */
const DOS_DATE_1980 = 0x0021;
const DOS_TIME_MIDNIGHT = 0;

/**
 * Build a single-disk, no-compression ZIP archive from the given entries.
 *
 * Layout: one local file header + payload per entry, then the central
 * directory, then the end-of-central-directory record. No data descriptors,
 * no zip64 — a social highlight batch is far below the 4 GiB / 65 535 entry
 * limits, and any archive at that size would exhaust the browser anyway.
 */
export function buildZip(files: ZipFile[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = file.data;
    const size = data.length;
    const crc = crc32(data);
    if (size > 0xffffffff) throw new Error(`zip entry too large: ${file.name}`);

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed to extract
    lv.setUint16(6, 0, true); // general purpose flags
    lv.setUint16(8, 0, true); // compression method: store
    lv.setUint16(10, DOS_TIME_MIDNIGHT, true);
    lv.setUint16(12, DOS_DATE_1980, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size == uncompressed for store
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed to extract
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, DOS_TIME_MIDNIGHT, true);
    cv.setUint16(14, DOS_DATE_1980, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    // 30 extra length, 32 comment length, 34 disk start, 36 internal attrs,
    // 38 external attrs all stay 0.
    cv.setUint32(42, offset, true); // offset of the matching local header
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory signature
  ev.setUint16(4, 0, true); // this disk number
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, files.length, true); // entries on this disk
  ev.setUint16(10, files.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, 0, true); // comment length

  const out = new Uint8Array(offset + centralSize + end.length);
  let p = 0;
  for (const chunk of locals) {
    out.set(chunk, p);
    p += chunk.length;
  }
  for (const chunk of centrals) {
    out.set(chunk, p);
    p += chunk.length;
  }
  out.set(end, p);
  return out;
}
