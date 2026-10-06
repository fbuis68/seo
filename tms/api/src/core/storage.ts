import { Injectable } from '@nestjs/common';
import { createReadStream } from 'fs';
import { mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { config } from '../config';
import { sha256 } from './crypto';

/**
 * Stockage objet privé par organisme. Implémentation disque locale ; même contrat
 * qu'un stockage compatible S3 (clé = tenant/espace/uuid). Originaux immuables.
 */
@Injectable()
export class StorageService {
  private root = resolve(config.storageDir);

  key(tenantId: string, area: string, id: string) { return `${tenantId}/${area}/${id}`; }

  private path(key: string) {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('clé de stockage invalide');
    return p;
  }

  async put(key: string, data: Buffer): Promise<{ sha256: string; size: number }> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx' }); // jamais d'écrasement
    return { sha256: sha256(data), size: data.length };
  }
  async get(key: string): Promise<Buffer> { return readFile(this.path(key)); }
  stream(key: string) { return createReadStream(this.path(key)); }
  async exists(key: string) { return stat(this.path(key)).then(() => true, () => false); }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}
