import { crc32 } from 'zlib';

/** Écrit un ZIP "stored" minimal (permet de fabriquer des archives malveillantes pour la recette). */
export function makeZip(entries: { name: string; data: Buffer | string; symlink?: boolean; encrypted?: boolean }[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const plain = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    // Entrée chiffrée (ZipCrypto) : en-tête de 12 octets précédant les données.
    const data = e.encrypted ? Buffer.concat([Buffer.alloc(12, 7), plain]) : plain;
    const name = Buffer.from(e.name);
    const crc = crc32(plain);
    const flag = e.encrypted ? 1 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(plain.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flag, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(plain.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
