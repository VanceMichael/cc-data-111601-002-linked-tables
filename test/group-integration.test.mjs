import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';

async function withService(run) {
  const directory = await mkdtemp(join(tmpdir(), 'group-intake-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    await run({ directory, provider, service });
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const setPhase = (provider, phase) => fetch(`${provider.url}/_phase`, {
  method: 'POST', body: JSON.stringify({ phase }),
});
const intake = (service, path) => fetch(`${service.url}/intakes`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path }),
});

test('从 /intakes 一次领取表组并持久化全部原件', async () => {
  await withService(async ({ directory, provider, service }) => {
    const response = await intake(service, '/metadata');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.kind, 'table-group');
    assert.equal(record.state, 'complete');
    assert.equal(record.delivery.status, 'ready');
    assert.deepEqual(record.delivery.summary, { rows: 6, ready: 6, blocked: 0, warnings: 0 });
    assert.deepEqual(record.documents.map(document => document.path), [
      '/metadata', '/primary', '/tables/campuses.csv', '/tables/projects.csv',
    ]);
    // Every original byte stream is retrievable and verified by digest.
    for (const document of record.documents) {
      const bytes = Buffer.from(await (await fetch(`${service.url}/objects/${document.digest}`)).arrayBuffer());
      assert.equal(bytes.length, document.bytes);
    }
    const stored = await new Store(directory).list();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, record.id);
    assert.equal((await (await fetch(`${service.url}/groups/${record.id}`)).json()).id, record.id);
    // Repeating the same entry returns the original id instead of duplicating.
    const repeated = await (await intake(service, '/metadata')).json();
    assert.equal(repeated.id, record.id);
    assert.equal((await new Store(directory).list()).length, 1);
  });
});

test('缺表时仍返回可交付记录，并说明暂时不能交付的原因', async () => {
  await withService(async ({ provider, service }) => {
    await setPhase(provider, 1);
    const response = await intake(service, '/metadata');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.state, 'incomplete');
    assert.equal(record.delivery.status, 'partial');
    assert.deepEqual(record.delivery.summary, { rows: 4, ready: 2, blocked: 2, warnings: 0 });
    assert.deepEqual(record.reasons, [
      { code: 'reference_unavailable', kind: 'pending', count: 2 },
    ]);
    assert.deepEqual(record.pending, [{
      type: 'member',
      url: `${provider.url}/tables/projects.csv`,
      status: 'unavailable',
      code: 'source_status_503',
      message: 'source_status_503',
      kind: 'pending',
    }]);
    const projects = record.members.find(member => member.name === 'projects');
    assert.equal(projects.status, 'unavailable');
    assert.equal(projects.digest, null);
    assert.equal(projects.rows, undefined);
    // Ready rows still carry their resolved references.
    assert.equal(record.delivery.ready[0].references[0].status, 'resolved');
    assert.deepEqual(record.delivery.blocked.map(row => row.table), ['campuses', 'campuses']);

    // Once the source recovers, the same entry produces a different, complete
    // snapshot; the missing-table snapshot is not overwritten as a success.
    await setPhase(provider, 0);
    const complete = await (await intake(service, '/metadata')).json();
    assert.notEqual(complete.id, record.id);
    assert.equal(complete.state, 'complete');
    const deliveries = await (await fetch(`${service.url}/deliveries`)).json();
    assert.deepEqual(deliveries.groups.map(delivery => [delivery.state, delivery.delivery]), [
      ['incomplete', 'partial'], ['complete', 'ready'],
    ]);
    assert.deepEqual(deliveries.groups[0].pending[0].code, 'source_status_503');
    assert.deepEqual(deliveries.pending, [{
      group: record.id,
      ...record.pending[0],
    }]);
  });
});

test('重复主键与悬空引用分别可见，不只报一个错误', async () => {
  await withService(async ({ provider, service }) => {
    await setPhase(provider, 2);
    const record = await (await intake(service, '/metadata')).json();
    assert.equal(record.state, 'complete');
    assert.equal(record.delivery.status, 'partial');
    assert.deepEqual(record.reasons, [
      { code: 'ambiguous_reference', kind: 'data', count: 1 },
      { code: 'dangling_reference', kind: 'data', count: 1 },
      { code: 'duplicate_primary_key', kind: 'data', count: 2 },
    ]);
    assert.deepEqual(record.delivery.ready.map(row => [row.table, row.row]), [
      ['primary', 1], ['primary', 2],
    ]);
    const projects = record.members.find(member => member.name === 'projects');
    assert.deepEqual(projects.duplicateKeys, [{
      columns: ['id'], values: ['p1'], rows: [1, 2], count: 2,
    }]);
    assert.deepEqual(projects.duplicateRows, [{ rows: [1, 2], count: 2 }]);
    const dangling = record.delivery.blocked.find(row => row.table === 'campuses' && row.row === 2);
    assert.deepEqual(dangling.references[0].values, ['p2']);
    assert.equal(dangling.reasons[0].code, 'dangling_reference');
    const ambiguous = record.delivery.blocked.find(row => row.table === 'campuses' && row.row === 1);
    assert.equal(ambiguous.reasons[0].code, 'ambiguous_reference');
  });
});

test('单表接口保持兼容，元数据入口自动领取整个表组', async () => {
  await withService(async ({ service }) => {
    const single = await intake(service, '/primary');
    assert.equal(single.status, 201);
    const record = await single.json();
    assert.equal(record.kind, undefined);
    assert.equal(record.parsed.kind, 'single-table');
    const group = await (await intake(service, '/metadata')).json();
    assert.equal(group.kind, 'table-group');
    assert.equal((await new Store(service.store.directory).list()).length, 2);
    const delimited = await fetch(`${service.url}/group-intakes`, {
      method: 'POST', body: JSON.stringify({ path: '/metadata' }),
    });
    assert.equal(delimited.status, 201);
    assert.equal((await delimited.json()).id, group.id);
    assert.equal((await intake(service, 'https://example.invalid/metadata')).status, 422);
  });
});
