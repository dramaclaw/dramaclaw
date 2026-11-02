// @ts-check
/**
 * A zip of files as they are (stored, not compressed: what goes in here is PNG, JPEG or media, compressed already).
 * Zip64 where the archive needs it (more than 65,535 entries, a file or the whole past 4 GB), so a long PNG sequence or
 * a project with its footage is still one file.
 */
import { open } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** How much of a file is read at a time. */
const PIECE = 4 << 20;

/** Today as MS-DOS time and date (what a zip entry carries). */
function dosStamp(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Write `entries` (a name inside the zip, and the file on disk or the bytes themselves) to the zip `out`. A file is
 * read a piece at a time (footage can be gigabytes); its size is taken before, its checksum while it is copied and
 * written into its header after. `signal` stops it between pieces.
 * @param {string} out @param {({ name: string, file: string } | { name: string, data: Buffer })[]} entries @param {AbortSignal} [signal]
 * @param {(bytes: number) => void} [onBytes] how many bytes of the entries are in so far
 */
export async function zipFiles(out, entries, signal, onBytes = () => {}) {
  const fh = await open(out, 'w');
  const { time, day } = dosStamp();
  /** @type {{ name: Buffer, crc: number, size: number, offset: number }[]} */
  const written = [];
  let offset = 0;
  let copied = 0;
  const put = async (/** @type {Buffer} */ buf) => { await fh.write(buf, 0, buf.length, offset); offset += buf.length; };
  try {
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('cancelled');
      const source = 'data' in entry ? null : await open(entry.file, 'r');
      try {
        const size = source ? (await source.stat()).size : /** @type {{ data: Buffer }} */ (entry).data.length;
        const big = size >= MAX32;
        const name = Buffer.from(entry.name, 'utf8');
        /* past 4 GB the sizes are in a zip64 field: the header says so with 0xffffffff */
        const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
        if (big) {
          extra.writeUInt16LE(0x0001, 0);
          extra.writeUInt16LE(16, 2);
          extra.writeBigUInt64LE(BigInt(size), 4);
          extra.writeBigUInt64LE(BigInt(size), 12);
        }
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0);
        head.writeUInt16LE(big ? 45 : 20, 4); // version needed
        head.writeUInt16LE(0x0800, 6); // names are UTF-8
        head.writeUInt16LE(0, 8); // stored
        head.writeUInt16LE(time, 10);
        head.writeUInt16LE(day, 12);
        head.writeUInt32LE(big ? MAX32 : size, 18);
        head.writeUInt32LE(big ? MAX32 : size, 22);
        head.writeUInt16LE(name.length, 26);
        head.writeUInt16LE(extra.length, 28);
        const at = offset;
        await put(head);
        await put(name);
        await put(extra);
        let crc = 0;
        if (!source) {
          const data = /** @type {{ data: Buffer }} */ (entry).data;
          crc = crc32(data);
          await put(data);
          onBytes(copied += data.length);
        } else {
          const piece = Buffer.alloc(Math.min(PIECE, Math.max(1, size)));
          for (let read = 0; read < size;) {
            if (signal?.aborted) throw new Error('cancelled');
            const { bytesRead } = await source.read(piece, 0, Math.min(piece.length, size - read), read);
            if (!bytesRead) throw new Error(`${entry.name}: changed while it was being zipped`);
            const chunk = piece.subarray(0, bytesRead);
            crc = crc32(chunk, crc);
            await put(chunk);
            read += bytesRead;
            onBytes(copied += bytesRead);
          }
        }
        const sum = Buffer.alloc(4);
        sum.writeUInt32LE(crc, 0);
        await fh.write(sum, 0, 4, at + 14);
        written.push({ name, crc, size, offset: at });
      } finally {
        await source?.close();
      }
    }

    const cdStart = offset;
    for (const e of written) {
      const big = e.size >= MAX32;
      const far = e.offset >= MAX32;
      /* the zip64 field holds, in this order, what does not fit: the sizes, then where the entry starts */
      const fields = [...(big ? [e.size, e.size] : []), ...(far ? [e.offset] : [])];
      const extra = Buffer.alloc(fields.length ? 4 + fields.length * 8 : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0); // zip64 extended information
        extra.writeUInt16LE(fields.length * 8, 2);
        fields.forEach((n, i) => extra.writeBigUInt64LE(BigInt(n), 4 + i * 8));
      }
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE(fields.length ? 45 : 20, 4); // made by
      head.writeUInt16LE(fields.length ? 45 : 20, 6); // needed
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(0, 10);
      head.writeUInt16LE(time, 12);
      head.writeUInt16LE(day, 14);
      head.writeUInt32LE(e.crc, 16);
      head.writeUInt32LE(big ? MAX32 : e.size, 20);
      head.writeUInt32LE(big ? MAX32 : e.size, 24);
      head.writeUInt16LE(e.name.length, 28);
      head.writeUInt16LE(extra.length, 30);
      // comment length, disk, internal and external attributes: 0
      head.writeUInt32LE(far ? MAX32 : e.offset, 42);
      await put(head);
      await put(e.name);
      await put(extra);
    }
    const cdSize = offset - cdStart;

    const zip64 = written.length >= MAX16 || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4); // size of the rest of this record
      record.writeUInt16LE(45, 12);
      record.writeUInt16LE(45, 14);
      // this disk, the disk with the directory: 0
      record.writeBigUInt64LE(BigInt(written.length), 24);
      record.writeBigUInt64LE(BigInt(written.length), 32);
      record.writeBigUInt64LE(BigInt(cdSize), 40);
      record.writeBigUInt64LE(BigInt(cdStart), 48);
      const recordAt = offset;
      await put(record);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordAt), 8);
      locator.writeUInt32LE(1, 16); // disks
      await put(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? MAX16 : written.length, 8);
    end.writeUInt16LE(zip64 ? MAX16 : written.length, 10);
    end.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? MAX32 : cdStart, 16);
    await put(end);
  } finally {
    await fh.close();
  }
}
