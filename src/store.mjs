import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
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
      const existing = records.find(record => record.digest === digest && record.source === source);
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
  // Persist every original byte stream once and register the group under a
  // digest that covers the entry, the metadata, and all obtained members (with
  // their URLs, so an unavailable member cannot collide with a later snapshot
  // that has a different, or empty, set). A repeated collection of unchanged
  // documents returns the original id.
  async acceptGroup(result) {
    const artifacts = result.artifacts ?? [];
    const digest = createHash('sha256').update(JSON.stringify({
      source: result.source,
      entry: result.entry,
      metadata: result.metadata.digest,
      documents: artifacts.map(artifact => [artifact.url, artifact.digest])
        .sort(([left], [right]) => left.localeCompare(right)),
    })).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.kind === 'table-group'
        && record.digest === digest && record.source === result.source);
      if (existing) return existing;
      for (const artifact of artifacts) {
        if (!/^[a-f0-9]{64}$/.test(artifact.digest)) continue;
        try { await writeFile(join(this.directory, 'objects', artifact.digest), artifact.bytes, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      const { artifacts: ignored, ...record } = result;
      record.id = randomUUID();
      record.kind = 'table-group';
      record.digest = digest;
      record.bytes = artifacts.reduce((total, artifact) => total + artifact.bytes.length, 0);
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async group(id) {
    const record = (await this.list()).find(item => item.kind === 'table-group' && item.id === id);
    if (!record) throw new Error('group_not_found');
    return record;
  }
  // A compact view of what can be handed over now and what is still missing.
  // Records remain the durable original; deliveries only interpret them.
  async deliveries() {
    return (await this.list()).filter(record => record.kind === 'table-group')
      .map(record => ({
        id: record.id,
        entry: record.entry,
        state: record.state,
        delivery: record.delivery.status,
        summary: record.delivery.summary,
        reasons: record.reasons,
        pending: record.pending,
        memberIssues: record.memberIssues ?? [],
        members: record.memberSummary,
      }));
  }
  async pendingDeliveries() {
    return (await this.list()).filter(record => record.kind === 'table-group')
      .flatMap(record => record.pending.map(item => ({ group: record.id, ...item })));
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
}
