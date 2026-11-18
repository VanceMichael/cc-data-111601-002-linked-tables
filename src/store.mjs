import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.kind !== 'table-group'
        && record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  /**
   * Persist a table-group acquisition.  Every acquired member is stored by
   * digest so the group can be re-verified without the source, and a repeated
   * intake of the same source fingerprint returns the original id.
   */
  async acceptGroup(report, artifacts, source) {
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.kind === 'table-group'
        && record.fingerprint === report.fingerprint && record.source === source);
      if (existing) return existing;
      for (const artifact of artifacts) {
        const target = join(this.directory, 'objects', artifact.digest);
        try { await access(target); }
        catch { await writeFile(target, artifact.bytes); }
      }
      const record = {
        id: randomUUID(),
        kind: 'table-group',
        source,
        fingerprint: report.fingerprint,
        status: report.status,
        entry: report.entry,
        bytes: artifacts.reduce((total, artifact) => total + artifact.bytes.length, 0),
        artifacts: artifacts.map(artifact => ({ url: artifact.url, role: artifact.role,
          digest: artifact.digest, bytes: artifact.bytes.length,
          contentType: artifact.contentType })),
        report
      };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
