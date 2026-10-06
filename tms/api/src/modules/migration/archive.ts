/**
 * Inspection et extraction sécurisées des paquets de sauvegarde.
 * Aucun accès réseau, aucune exécution : lecture d'octets locaux uniquement.
 */
import yauzl, { Entry, ZipFile } from 'yauzl';

export interface ArchiveLimits { maxEntries: number; maxTotalUncompressed: number; maxEntrySize: number; maxRatio: number }
export const DEFAULT_LIMITS: ArchiveLimits = {
  maxEntries: 10_000, maxTotalUncompressed: 5 * 1024 ** 3, maxEntrySize: 100 * 1024 ** 2, maxRatio: 100,
};

export type FileKind = 'table' | 'document' | 'manifest' | 'unknown';
export interface InventoryEntry { path: string; size: number; kind: FileKind; ext: string }
export interface Rejection { code: string; message: string; path?: string }

const TABLE_EXT = ['csv', 'tsv', 'txt', 'xlsx', 'json', 'xml'];
const DOC_EXT = ['pdf', 'png', 'jpg', 'jpeg', 'docx', 'odt', 'eml', 'msg', 'html', 'htm'];
const NESTED = ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'];
const MACRO = ['xlsm', 'xltm', 'xlsb', 'docm', 'dotm', 'pptm', 'xla', 'xlam'];
const EXEC = ['exe', 'bat', 'cmd', 'com', 'sh', 'ps1', 'vbs', 'js', 'jar', 'msi', 'dll', 'scr'];
const DUMP = ['sql', 'dump', 'bak', 'mdb', 'accdb', 'db', 'sqlite', 'fdb'];

export const extOf = (p: string) => (p.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

export function classify(path: string): FileKind | Rejection {
  const ext = extOf(path);
  const name = path.split('/').pop()!.toLowerCase();
  if (name === 'manifest.json') return 'manifest';
  if (NESTED.includes(ext)) return { code: 'nested_archive', message: 'Archive imbriquée refusée : déposez une archive à un seul niveau.', path };
  if (MACRO.includes(ext)) return { code: 'macro_file', message: 'Fichier à macros refusé (aucune macro n’est exécutée) : enregistrez en .xlsx ou .csv.', path };
  if (EXEC.includes(ext)) return { code: 'executable', message: 'Fichier exécutable refusé.', path };
  if (DUMP.includes(ext)) return { code: 'database_dump', message: 'Dump/base propriétaire : jamais exécuté. Nécessite un adaptateur spécifique validé sur échantillon ; joignez les exports officiels du logiciel.', path };
  if (TABLE_EXT.includes(ext)) return 'table';
  if (DOC_EXT.includes(ext)) return 'document';
  return 'unknown';
}

/** Chemin sûr : relatif, sans remontée, sans caractère de contrôle. */
export function safePath(p: string): boolean {
  if (!p || p.includes('\0') || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return !p.split('/').some((seg) => seg === '..');
}

const openBuffer = (buf: Buffer) => new Promise<ZipFile>((res, rej) =>
  yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (e, z) => (e ? rej(e) : res(z!))));

/** Énumère et extrait (en mémoire, borné) les entrées d'une archive ZIP selon les limites. */
export async function readZip(buf: Buffer, limits = DEFAULT_LIMITS, wantData = true): Promise<{ entries: (InventoryEntry & { data?: Buffer })[]; rejections: Rejection[] }> {
  const zip = await openBuffer(buf).catch(() => { throw Object.assign(new Error('Archive ZIP illisible ou corrompue'), { code: 'invalid_zip' }); });
  const entries: (InventoryEntry & { data?: Buffer })[] = [];
  const rejections: Rejection[] = [];
  let total = 0, count = 0;
  return new Promise((resolve, reject) => {
    const fail = (r: Rejection) => { rejections.push(r); zip.close(); resolve({ entries, rejections }); };
    // yauzl refuse lui-même certains chemins dangereux : traduits en rejet explicite.
    zip.on('error', (e: Error) => {
      const unsafe = /invalid relative path|absolute path|invalid characters in fileName/i.test(e.message);
      resolve({ entries, rejections: [...rejections, { code: unsafe ? 'unsafe_path' : 'invalid_zip', message: unsafe ? 'Chemin sortant du dossier de l’archive refusé.' : `Archive invalide : ${e.message}` }] });
    });
    zip.on('end', () => resolve({ entries, rejections }));
    zip.on('entry', (entry: Entry) => {
      count++;
      if (count > limits.maxEntries) return fail({ code: 'too_many_entries', message: `Plus de ${limits.maxEntries} fichiers dans l'archive.` });
      const path = entry.fileName;
      if (path.endsWith('/')) return zip.readEntry();
      if (!safePath(path)) return fail({ code: 'unsafe_path', message: 'Chemin sortant du dossier de l’archive refusé.', path });
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) return fail({ code: 'symlink', message: 'Lien symbolique refusé.', path });
      if (entry.generalPurposeBitFlag & 0x1) return fail({ code: 'encrypted', message: 'Archive chiffrée non prise en charge : fournissez une copie déchiffrée par un canal sécurisé.', path });
      if (entry.uncompressedSize > limits.maxEntrySize) return fail({ code: 'entry_too_large', message: `Fichier supérieur à ${Math.round(limits.maxEntrySize / 1024 ** 2)} Mo.`, path });
      if (entry.compressedSize > 0 && entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / entry.compressedSize > limits.maxRatio) {
        return fail({ code: 'compression_ratio', message: 'Taux de compression excessif (bombe de décompression suspectée).', path });
      }
      total += entry.uncompressedSize;
      if (total > limits.maxTotalUncompressed) return fail({ code: 'too_large_uncompressed', message: 'Volume décompressé total dépassé.' });
      const kind = classify(path);
      if (typeof kind !== 'string') return fail(kind);
      if (!wantData) { entries.push({ path, size: entry.uncompressedSize, kind, ext: extOf(path) }); return zip.readEntry(); }
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = []; let n = 0;
        stream!.on('data', (c: Buffer) => {
          n += c.length;
          if (n > limits.maxEntrySize) { stream!.destroy(); return fail({ code: 'entry_too_large', message: 'Taille réelle supérieure à la taille déclarée.', path }); }
          chunks.push(c);
        });
        stream!.on('error', (e) => fail({ code: 'invalid_entry', message: `Entrée illisible : ${e.message}`, path }));
        stream!.on('end', () => { entries.push({ path, size: n, kind, ext: extOf(path), data: Buffer.concat(chunks) }); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}

export const isZip = (buf: Buffer) => buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
