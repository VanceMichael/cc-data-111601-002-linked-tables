import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
import { Store } from '../src/store.mjs';
import { normalizeTableGroup } from '../src/csvw.mjs';

/** Serve an in-memory publication; every request path is recorded. */
async function startSyntheticSource(routes) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    requests.push(path);
    const route = routes[path];
    if (!route) { response.writeHead(404); return response.end('not_found'); }
    if (route.status && route.status !== 200) {
      response.writeHead(route.status); return response.end('unavailable');
    }
    response.setHeader('Content-Type', route.type ?? 'text/csv');
    response.end(route.body ?? '');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function withStack(routes, run) {
  const directory = await mkdtemp(join(tmpdir(), 'group-test-'));
  const source = await startSyntheticSource(routes);
  const service = await startService({ source: source.url, directory });
  try {
    return await run({ source, service, directory });
  } finally {
    await service.close(); await source.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function intake(service, path) {
  return fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
}

function studentsColumn(studentNull) {
  return studentNull === undefined
    ? { name: 'campus' }
    : { name: 'campus', null: studentNull };
}

/** Metadata lives in /catalog while two members live elsewhere. */
function exchangeRoutes({ studentNull } = {}) {
  return {
    '/catalog/exchange.json': {
      type: 'application/json',
      body: JSON.stringify({
        '@context': 'http://www.w3.org/ns/csvw',
        tables: [
          { url: 'students.csv', tableSchema: {
            columns: [{ name: 'student' }, studentsColumn(studentNull), { name: 'country' }],
            primaryKey: 'student',
            foreignKeys: [{ columnReference: ['campus', 'country'],
              reference: { resource: '../shared/campuses.csv',
                columnReference: ['code', 'country'] } }]
          } },
          { url: '../shared/campuses.csv', tableSchema: {
            columns: [{ name: 'code' }, { name: 'country' }, { name: 'project' }],
            primaryKey: ['code', 'country'],
            foreignKeys: [{ columnReference: 'project',
              reference: { resource: '../../registry/projects.csv', columnReference: 'id' } }]
          } },
          { url: '../registry/projects.csv', tableSchema: {
            columns: [{ name: 'id' }, { name: 'campus' }, { name: 'country' }],
            primaryKey: 'id',
            foreignKeys: [{ columnReference: ['campus', 'country'],
              reference: { resource: '../shared/campuses.csv',
                columnReference: ['code', 'country'] } }]
          } }
        ]
      })
    },
    '/catalog/students.csv': { body: 'student,campus,country\ns1,c1,CN\ns2,,CN\n' },
    '/shared/campuses.csv': { body: 'code,country,project\nc1,CN,p1\n' },
    '/registry/projects.csv': { body: 'id,campus,country\np1,c1,CN\n' }
  };
}

test('表组按元数据 base 解析相对链接并跟进另一目录的成员', async () => {
  // Explicit null=[] means the empty campus is data, so s2's link dangles.
  await withStack(exchangeRoutes({ studentNull: [] }), async ({ source, service, directory }) => {
    const response = await intake(service, '/catalog/exchange.json');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.kind, 'table-group');
    const urls = record.report.tables.map(table => table.url).sort();
    assert.deepEqual(urls, [
      `${source.url}/catalog/students.csv`,
      `${source.url}/registry/projects.csv`,
      `${source.url}/shared/campuses.csv`
    ].sort());
    assert.ok(record.report.tables.every(table => table.acquired));
    // Each published member is fetched once; the cyclic graph terminates.
    for (const path of ['/catalog/students.csv', '/shared/campuses.csv', '/registry/projects.csv']) {
      assert.equal(source.requests.filter(requested => requested === path).length, 1, path);
    }
    const student = record.report.records.find(entry => entry.key?.[0] === 's1');
    assert.equal(student.references[0].status, 'resolved');
    const nullStudent = record.report.blocked.find(entry => entry.key?.[0] === 's2');
    assert.equal(nullStudent.code, 'reference_dangling');
    assert.deepEqual(nullStudent.referenceValues, ['', 'CN']);
    assert.equal(record.status, 'incomplete');

    const stored = (await new Store(directory).list())[0];
    assert.equal(stored.id, record.id);
    assert.equal(stored.artifacts.length, 4);
    const fetched = await fetch(`${service.url}/objects/${stored.artifacts[1].digest}`);
    assert.equal(fetched.status, 200);
    assert.equal(Buffer.from(await fetched.arrayBuffer()).toString(),
      'student,campus,country\ns1,c1,CN\ns2,,CN\n');
  });
});

test('未取得的引用成员、数据悬空引用与允许为空的复合键被区分', async () => {
  await withStack({
    ...exchangeRoutes(),
    '/catalog/students.csv': { body: 'student,campus,country\ns1,c1,CN\ns2,,CN\ns9,c9,CN\n' },
    '/registry/projects.csv': { status: 503 }
  }, async ({ service }) => {
    const record = await (await intake(service, '/catalog/exchange.json')).json();
    assert.equal(record.status, 'incomplete');
    assert.deepEqual(record.report.notAcquired.map(item => item.code), ['source_status_503']);
    assert.ok(record.report.notAcquired[0].url.endsWith('/registry/projects.csv'));

    const codes = record.report.blocked.map(item => item.code);
    // A member that was never obtained is reported as unavailable, not as a
    // dangling reference in data that was fetched.
    assert.ok(codes.includes('reference_target_unavailable'));
    assert.ok(codes.includes('reference_dangling'));
    assert.ok(codes.includes('reference_target_not_deliverable'));

    const blockedStudent = record.report.blocked.find(item => item.key?.[0] === 's1');
    assert.equal(blockedStudent.code, 'reference_target_not_deliverable');
    // Nullable campus on s2 yields no reference at all and stays deliverable.
    const usableStudents = record.report.records
      .filter(entry => entry.table.endsWith('/students.csv'));
    assert.deepEqual(usableStudents.map(entry => entry.key[0]), ['s2']);
    assert.equal(usableStudents[0].references[0].status, 'optional');
  });
});

test('悬空引用保留原因且不掩盖同一表中的可用记录', async () => {
  await withStack({
    ...exchangeRoutes(),
    '/catalog/students.csv': { body: 'student,campus,country\ns1,c1,CN\ns2,,CN\ns9,c9,CN\n' }
  }, async ({ service }) => {
    const record = await (await intake(service, '/catalog/exchange.json')).json();
    assert.equal(record.status, 'incomplete');
    assert.deepEqual(record.report.notAcquired, []);
    const dangling = record.report.blocked.filter(item => item.code === 'reference_dangling');
    assert.deepEqual(dangling.map(item => item.key[0]), ['s9']);
    assert.deepEqual(dangling[0].referenceValues, ['c9', 'CN']);
    const usableStudents = record.report.records
      .filter(entry => entry.table.endsWith('/students.csv'))
      .map(entry => entry.key[0]).sort();
    assert.deepEqual(usableStudents, ['s1', 's2']);
  });
});

test('重复键的每份记录都被阻止，重复行不被合并或覆盖', async () => {
  await withStack({
    ...exchangeRoutes(),
    '/shared/campuses.csv': { body: 'code,country,project\nc1,CN,p2\n' },
    '/registry/projects.csv': {
      body: 'id,campus,country\np1,c1,CN\np1,c1,CN\np1,c2,AU\np2,c1,CN\n'
    }
  }, async ({ service }) => {
    const record = await (await intake(service, '/catalog/exchange.json')).json();
    const projects = record.report.tables.find(table => table.url.endsWith('/registry/projects.csv'));
    assert.equal(projects.rowCount, 4);
    assert.equal(projects.usableCount, 1);
    assert.equal(projects.blockedCount, 3);
    const duplicateKey = record.report.blocked
      .filter(item => item.code === 'duplicate_primary_key')
      .map(item => item.row);
    assert.deepEqual(duplicateKey, [1, 2, 3]);
    for (const item of record.report.blocked.filter(entry => entry.code === 'duplicate_primary_key')) {
      assert.deepEqual(item.rows, [1, 2, 3]);
    }
    const duplicateRows = record.report.issues.filter(issue => issue.code === 'duplicate_row');
    assert.equal(duplicateRows.length, 1);
    assert.deepEqual(duplicateRows[0].rows, [1, 2]);
    // The unique key is still deliverable and its reference graph is clean.
    const p2 = record.report.records.find(entry => entry.table.endsWith('/projects.csv'));
    assert.deepEqual(p2.key, ['p2']);
    assert.equal(p2.references[0].status, 'resolved');
  });
});

test('缺陷沿合法循环传播到引用链上的记录', async () => {
  await withStack({
    ...exchangeRoutes(),
    '/shared/campuses.csv': { body: 'code,country,project\nc1,CN,p1\n' },
    '/registry/projects.csv': { body: 'id,campus,country\np1,c1,CN\np1,c1,CN\n' }
  }, async ({ service }) => {
    const record = await (await intake(service, '/catalog/exchange.json')).json();
    // projects rows 1 and 2 share a key; the campus and student that resolve
    // into that cycle are withheld with a stated reason while the duplicate
    // rows themselves remain visible.  s2's default-null campus yields no
    // reference, so it is still deliverable.
    assert.equal(record.status, 'incomplete');
    const project = record.report.tables.find(table => table.url.endsWith('/projects.csv'));
    assert.equal(project.rowCount, 2);
    assert.equal(project.usableCount, 0);
    assert.deepEqual(project.issues.filter(issue => issue.code === 'duplicate_primary_key')
      .map(issue => issue.rows), [[1, 2]]);
    const campus = record.report.tables.find(table => table.url.endsWith('/campuses.csv'));
    assert.equal(campus.usableCount, 0);
    assert.equal(campus.blockedCount, 1);
    const students = record.report.tables.find(table => table.url.endsWith('/students.csv'));
    assert.equal(students.usableCount, 1);
    assert.equal(students.blockedCount, 1);
    assert.deepEqual(record.report.records.map(entry => entry.key[0]), ['s2']);
    for (const item of record.report.blocked) {
      assert.ok(item.code);
    }
  });
});

test('合法循环引用图完成领取且不重复请求', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'group-cycle-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const response = await intake(service, '/metadata');
    assert.equal(response.status, 201);
    const record = await response.json();
    assert.equal(record.status, 'complete');
    assert.equal(record.report.records.length, 6);
    const requested = (await (await fetch(`${provider.url}/_requests`)).json())
      .map(item => item.path.split('?')[0]);
    for (const path of ['/primary', '/tables/campuses.csv', '/tables/projects.csv']) {
      assert.equal(requested.filter(item => item === path).length, 1, path);
    }
    const student = record.report.records.find(entry => entry.table.endsWith('/primary')
      && entry.key[0] === 's2');
    assert.equal(student.references[0].status, 'optional');
    assert.equal(student.values.campus, '');
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('表组领取持久化，重领返回原记录，摘要与详情可分别查询', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'group-persist-'));
  const provider = await startProvider();
  const service = await startService({ source: provider.url, directory });
  try {
    const first = await (await intake(service, '/metadata')).json();
    const repeated = await (await intake(service, '/metadata')).json();
    assert.equal(repeated.id, first.id);
    assert.equal((await new Store(directory).list()).length, 1);

    const summaries = await (await fetch(`${service.url}/records`)).json();
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].kind, 'table-group');
    assert.deepEqual(summaries[0].counts,
      { tables: 3, acquired: 3, records: 6, blocked: 0, notAcquired: 0 });
    assert.deepEqual(summaries[0].blockedReasons, {});
    assert.deepEqual(summaries[0].notAcquired, []);
    assert.equal(summaries[0].report, undefined);

    const detail = await (await fetch(`${service.url}/records/${first.id}`)).json();
    assert.equal(detail.report.records.length, 6);
    assert.equal((await fetch(`${service.url}/records/missing`)).status, 404);

    // Every member is stored by digest and survives a fresh store instance.
    for (const artifact of detail.artifacts) {
      assert.equal((await fetch(`${service.url}/objects/${artifact.digest}`)).status, 200);
    }
    assert.equal((await new Store(directory).list())[0].artifacts.length, 4);

    // The pre-existing single-table contract is unchanged for a plain CSV.
    const single = await (await intake(service, '/primary')).json();
    assert.notEqual(single.kind, 'table-group');
    assert.equal(single.parsed.kind, 'single-table');
  } finally {
    await service.close(); await provider.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('畸形元数据被拒绝而不是误读为 CSV', async () => {
  await withStack({
    '/catalog/broken.json': { type: 'application/json', body: '{"tables":' },
    '/catalog/nogroup.json': { type: 'application/json', body: '{"other":true}' },
    '/catalog/notables.json': { type: 'application/json', body: '{"tables":[]}' }
  }, async ({ service }) => {
    assert.equal((await intake(service, '/catalog/broken.json')).status, 422);
    assert.equal((await intake(service, '/catalog/nogroup.json')).status, 422);
    assert.equal((await intake(service, '/catalog/notables.json')).status, 422);
  });
});

test('元数据规范化遵循 base、单值与数组、null 覆盖和重复表声明', () => {
  const metadataUrl = 'http://example.test/meta/exchange.json';
  const group = normalizeTableGroup({
    '@base': '/root/',
    tables: [
      { url: 'a.csv', tableSchema: {
        null: [''],
        columns: [{ name: 'x' }, { name: 'y', null: [] }],
        primaryKey: 'x',
        foreignKeys: [{ columnReference: ['x'], reference: {
          resource: 'nested/b.csv', columnReference: 'x' } }]
      } },
      { url: 'a.csv', tableSchema: {
        null: [''],
        columns: [{ name: 'x' }, { name: 'y', null: [] }],
        primaryKey: 'x',
        foreignKeys: [{ columnReference: ['x'], reference: {
          resource: 'nested/b.csv', columnReference: 'x' } }]
      } },
      { url: 'a.csv', tableSchema: { columns: [{ name: 'x' }] } }
    ]
  }, metadataUrl);
  assert.equal(group.tables[0].url, 'http://example.test/root/a.csv');
  assert.equal(group.tables[0].columns[0].null[0], '');
  assert.deepEqual(group.tables[0].columns[1].null, []);
  assert.deepEqual(group.tables[0].primaryKey, ['x']);
  assert.deepEqual(group.tables[0].foreignKeys[0].columns, ['x']);
  assert.deepEqual(group.tables[0].foreignKeys[0].reference.columns, ['x']);
  assert.equal(group.tables[0].foreignKeys[0].reference.resource,
    'http://example.test/root/nested/b.csv');
  assert.ok(group.issues.some(issue => issue.code === 'duplicate_table_declaration'));
  // A second declaration that disagrees is a conflict, not a harmless repeat.
  assert.ok(group.issues.some(issue => issue.code === 'table_declaration_conflict'
    && issue.tableIndex === 2));
  assert.throws(() => normalizeTableGroup({}, metadataUrl), /metadata_tables_required/);
  assert.throws(() => normalizeTableGroup({ tables: [] }, metadataUrl), /metadata_tables_required/);
});

test('同一 URL 的冲突声明阻止该表全部行而不是任选其一', async () => {
  const metadata = JSON.stringify({ tables: [
    { url: '/tables/students.csv', tableSchema: {
      columns: [{ name: 'student' }, { name: 'campus' }],
      primaryKey: 'student',
      foreignKeys: [{ columnReference: 'campus',
        reference: { resource: '/tables/campuses.csv', columnReference: 'code' } }]
    } },
    { url: '/tables/campuses.csv', tableSchema: {
      columns: [{ name: 'code' }, { name: 'country' }], primaryKey: 'code'
    } },
    { url: '/tables/campuses.csv', tableSchema: {
      columns: [{ name: 'code' }, { name: 'project' }], primaryKey: 'code'
    } }
  ] });
  await withStack({
    '/tables/group.json': { type: 'application/json', body: metadata },
    '/tables/students.csv': { body: 'student,campus\ns1,c1\n' },
    '/tables/campuses.csv': { body: 'code,country\nc1,CN\n' }
  }, async ({ service }) => {
    const record = await (await intake(service, '/tables/group.json')).json();
    assert.equal(record.status, 'incomplete');
    const campuses = record.report.tables.find(table => table.url.endsWith('/campuses.csv'));
    assert.equal(campuses.usableCount, 0);
    assert.equal(campuses.blockedCount, 1);
    assert.ok(record.report.blocked.some(item => item.code === 'table_declaration_conflict'));
    assert.deepEqual(record.report.records, []);
    assert.ok(record.report.issues.some(issue => issue.code === 'table_declaration_conflict'));
  });
});
