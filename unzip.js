// Minimal streaming zip reader for restore and the 360-spin .zip upload. A
// backup holds every photo, so it can be well over a gigabyte; adm-zip reads the
// whole archive into one Buffer, which is more memory than a NAS, an SBC, or a
// shared host will give one process. This reads only the central directory up
// front and inflates each entry from disk straight into its destination file.
//
// Handles what our backups (and the native apps' exports) contain: stored or
// deflated entries, with Zip64 sizes/offsets for archives past 4GB.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const n = fs.readSync(fd, buf, 0, length, position);
  return buf.subarray(0, n);
}

// Lists the archive's entries: [{ name, isDirectory, method, compressedSize,
// size, headerOffset }]. Throws on anything that isn't a readable zip.
export function listEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    // The end-of-central-directory record sits in the last 22 bytes plus up to
    // a 64KB comment.
    const tailLen = Math.min(fileSize, 22 + 0xffff);
    const tail = readAt(fd, fileSize - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file');

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    // Zip64: the classic fields are saturated and the real values live in the
    // Zip64 end record, found via the locator just before the classic one.
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locPos = fileSize - tailLen + eocd - 20;
      const loc = readAt(fd, locPos, 20);
      if (loc.length < 20 || loc.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error('bad zip64 locator');
      const rec = readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
      if (rec.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('bad zip64 end record');
      count = Number(rec.readBigUInt64LE(32));
      cdSize = Number(rec.readBigUInt64LE(40));
      cdOffset = Number(rec.readBigUInt64LE(48));
    }

    const cd = readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) throw new Error('corrupt central directory');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let compressedSize = cd.readUInt32LE(p + 20);
      let size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let headerOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
      // Zip64 extra field: only the saturated values are present, in this order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (headerOffset === 0xffffffff) { headerOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      entries.push({ name, isDirectory: name.endsWith('/'), method, compressedSize, size, headerOffset, encrypted: !!(flags & 1) });
      p = xEnd + commentLen;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// Writes one entry's contents to `destPath`, streaming from disk.
//
// `maxBytes` caps what the entry may write. The sizes listEntries() reports are
// whatever the archive claims, and inflate keeps going past a false one, so a
// caller unpacking an untrusted upload passes it to make the size it checked
// binding. Past the cap the extraction fails, leaving a partial file at
// `destPath` for the caller to remove.
export async function extractEntry(zipPath, entry, destPath, { maxBytes = Infinity } = {}) {
  if (entry.encrypted) throw new Error(`${entry.name} is encrypted`);
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`${entry.name} uses an unsupported compression method`);
  // The local header's name/extra lengths can differ from the central copy's,
  // so the data offset has to come from the local header itself.
  const fd = fs.openSync(zipPath, 'r');
  let dataStart;
  try {
    const lfh = readAt(fd, entry.headerOffset, 30);
    if (lfh.length < 30 || lfh.readUInt32LE(0) !== LFH_SIG) throw new Error(`corrupt entry ${entry.name}`);
    dataStart = entry.headerOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
  } finally {
    fs.closeSync(fd);
  }
  const out = fs.createWriteStream(destPath);
  if (entry.compressedSize === 0) { out.end(); await new Promise((r, j) => out.on('finish', r).on('error', j)); return; }
  const src = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const stages = entry.method === 0 ? [src] : [src, zlib.createInflateRaw()];
  if (Number.isFinite(maxBytes)) {
    let seen = 0;
    stages.push(new Transform({
      transform(chunk, _enc, cb) {
        seen += chunk.length;
        cb(seen > maxBytes ? new Error(`${entry.name} is larger than it claims`) : null, chunk);
      },
    }));
  }
  await pipeline(...stages, out);
}
