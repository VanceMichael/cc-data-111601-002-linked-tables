import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateTableGroup,
  parseTableGroup,
  planTableGroup,
  readTableMember,
} from '../src/group.mjs';
import { courierTableGroup } from '../src/courier.mjs';

const base = 'http://source.test/metadata';
const metadata = JSON.parse(await readFile(new URL('../fixtures/resource-01.bin', import.meta.url)));
const campuses = await readFile(new URL('../fixtures/resource-02.bin', import.meta.url));
const projects = await readFile(new URL('../fixtures/resource-03.bin', import.meta.url));
const primary = await readFile(new URL('../fixtures/primary.bin', import.meta.url));

function sourceFor(documents) {
  const requests = [];
  const acquire = async (source, url) => {
    requests.push(url);
    const entry = documents[new URL(url).pathname];
    if (!entry) throw new Error('source_status_404');
    if (entry instanceof Error) throw entry;
    return { bytes: Buffer.from(entry) };
  };
  return { acquire, requests };
}

test('表组按元数据相对路径解析，循环引用只领取一次', async () => {
  const group = parseTableGroup(metadata, base);
  assert.deepEqual(group.tables.map(table => table.url), [
    'http://source.test/primary',
    'http://source.test/tables/campuses.csv',
    'http://source.test/tables/projects.csv',
  ]);
  assert.deepEqual(group.tables[1].primaryKey, ['code', 'country']);
  assert.deepEqual(group.tables[0].foreignKeys[0].reference, {
    resource: 'http://source.test/tables/campuses.csv',
    columnReference: ['code', 'country'],
    unsupported: [],
  });
  const plan = planTableGroup(group);
  assert.equal(plan.length, 3);
  const { acquire, requests } = sourceFor({
    '/metadata': Buffer.from(JSON.stringify(metadata)),
    '/primary': primary,
    '/tables/campuses.csv': campuses,
    '/tables/projects.csv': projects,
  });
  const result = await courierTableGroup({ source: 'http://source.test', path: '/metadata', acquire });
  assert.equal(result.state, 'complete');
  assert.equal(result.delivery.status, 'ready');
  assert.deepEqual(result.delivery.summary, { rows: 6, ready: 6, blocked: 0, warnings: 0 });
  assert.deepEqual(requests, [
    'http://source.test/metadata',
    'http://source.test/primary',
    'http://source.test/tables/campuses.csv',
    'http://source.test/tables/projects.csv',
  ]);
  const target = result.delivery.ready[0].references[0];
  assert.equal(target.status, 'resolved');
  assert.deepEqual(target.values, ['c1', 'CN']);
  assert.equal(target.target.row, 1);
});

test('未声明的引用表也会跟随，并标为隐含成员', async () => {
  const documents = {
    '/primary': primary,
    '/tables/campuses.csv': campuses,
    '/tables/projects.csv': projects,
  };
  const oneTable = {
    '@context': 'http://www.w3.org/ns/csvw',
    tables: [{
      url: '/primary',
      tableSchema: {
        columns: [{ name: 'student' }, { name: 'campus' }, { name: 'country' }],
        foreignKeys: [{
          columnReference: ['campus', 'country'],
          reference: { resource: 'tables/only.csv', columnReference: ['code', 'country'] },
        }],
      },
    }],
  };
  documents['/metadata'] = Buffer.from(JSON.stringify(oneTable));
  documents['/tables/only.csv'] = Buffer.from('code,country\nc1,CN\n');
  const { acquire, requests } = sourceFor(documents);
  const result = await courierTableGroup({ source: 'http://source.test', path: '/metadata', acquire });
  assert.deepEqual(requests, [
    'http://source.test/metadata',
    'http://source.test/primary',
    'http://source.test/tables/only.csv',
  ]);
  const implicit = result.members.find(member => member.url.endsWith('/tables/only.csv'));
  assert.equal(implicit.declared, false);
  assert.equal(implicit.status, 'acquired');
  assert.deepEqual(implicit.notes, ['implicit_member']);
  assert.deepEqual(implicit.columns, ['code', 'country']);
  assert.equal(result.delivery.status, 'ready');
  assert.equal(result.delivery.summary.rows, 3);
  assert.equal(result.delivery.summary.ready, 3);
  assert.deepEqual(result.delivery.ready[0].references[0].values, ['c1', 'CN']);
  assert.deepEqual(result.delivery.ready[0].references[0].target, {
    name: 'only', url: 'http://source.test/tables/only.csv', row: 1, digest: implicit.digest,
  });
});

test('尚未取得的表是 pending，而不是悬空引用', async () => {
  const group = parseTableGroup(metadata, base);
  const specs = planTableGroup(group);
  const members = [
    readTableMember(specs[0], primary),
    readTableMember(specs[1], campuses),
  ];
  const evaluation = evaluateTableGroup({ group, members, source: 'http://source.test' });
  assert.equal(evaluation.state, 'complete');
  assert.equal(evaluation.delivery.status, 'partial');
  assert.deepEqual(evaluation.reasons, [
    { code: 'reference_unavailable', kind: 'pending', count: 2 },
  ]);
  for (const row of evaluation.delivery.blocked) {
    assert.equal(row.references[0].status, 'pending');
    assert.equal(row.references[0].reason.kind, 'pending');
  }
  const missing = await courierTableGroup({
    source: 'http://source.test',
    path: '/metadata',
    acquire: sourceFor({
      '/metadata': Buffer.from(JSON.stringify(metadata)),
      '/primary': primary,
      '/tables/campuses.csv': campuses,
      '/tables/projects.csv': new Error('source_status_503'),
    }).acquire,
  });
  assert.equal(missing.state, 'incomplete');
  assert.deepEqual(missing.pending, [{
    type: 'member',
    url: 'http://source.test/tables/projects.csv',
    status: 'unavailable',
    code: 'source_status_503',
    message: 'source_status_503',
    kind: 'pending',
  }]);
  assert.equal(missing.members.find(member => member.name === 'projects').status, 'unavailable');
});

test('真实悬空引用和重复主键分别保留，不被 Map 覆盖', async () => {
  const group = parseTableGroup(metadata, base);
  const specs = planTableGroup(group);
  // p1 appears twice; p2 is gone, so campuses' p2 reference is genuinely
  // dangling instead of being masked by the duplicated p1 index entry.
  const duplicated = Buffer.from('id,campus,country\np1,c1,CN\np1,c1,CN\n');
  const members = [
    readTableMember(specs[0], primary),
    readTableMember(specs[1], campuses),
    readTableMember(specs[2], duplicated),
  ];
  const evaluation = evaluateTableGroup({ group, members, source: 'http://source.test' });
  assert.equal(evaluation.state, 'complete');
  assert.equal(evaluation.delivery.status, 'partial');
  assert.deepEqual(evaluation.reasons.map(reason => [reason.code, reason.count]), [
    ['ambiguous_reference', 1],
    ['dangling_reference', 1],
    ['duplicate_primary_key', 2],
  ]);
  const projectRows = evaluation.delivery.blocked.filter(row => row.table === 'projects');
  assert.deepEqual(projectRows.map(row => row.row), [1, 2]);
  assert.deepEqual(projectRows[0].reasons[0].rows, [1, 2]);
  assert.deepEqual(projectRows[0].warnings[0].rows, [1, 2]);
  const projects = evaluation.members.find(member => member.name === 'projects');
  assert.deepEqual(projects.duplicateRows, [{ rows: [1, 2], count: 2 }]);
  assert.deepEqual(projects.duplicateKeys, [{
    columns: ['id'], values: ['p1'], rows: [1, 2], count: 2,
  }]);
  const campusesRows = evaluation.delivery.blocked.filter(row => row.table === 'campuses');
  assert.deepEqual(campusesRows.map(row => row.reasons[0].code),
    ['ambiguous_reference', 'dangling_reference']);
  assert.deepEqual(campusesRows[0].references[0].values, ['p1']);
  assert.deepEqual(campusesRows[0].references[0].reason.rows, [1, 2]);
  assert.deepEqual(campusesRows[1].references[0].values, ['p2']);
});

test('复合键任一允许为空的分量为 null 时不产生引用且不阻塞', async () => {
  const group = parseTableGroup(metadata, base);
  const specs = planTableGroup(group);
  const members = [
    readTableMember(specs[0], primary),
    readTableMember(specs[1], campuses),
    readTableMember(specs[2], projects),
  ];
  const evaluation = evaluateTableGroup({ group, members, source: 'http://source.test' });
  const row = evaluation.delivery.ready.find(item => item.table === 'primary' && item.row === 2);
  assert.ok(row);
  const reference = row.references[0];
  assert.equal(reference.status, 'null_component');
  assert.deepEqual(reference.values, ['', 'CN']);
  assert.equal(reference.reason.code, 'null_reference_component');
  assert.equal(row.reasons.length, 0);
  // The first primary row still resolves normally.
  assert.equal(evaluation.delivery.ready.find(item => item.table === 'primary' && item.row === 1)
    .references[0].status, 'resolved');
});

test('列级 null=[] 关闭默认空字符串语义，非空键照样检查', async () => {
  const document = {
    '@context': 'http://www.w3.org/ns/csvw',
    tables: [
      {
        url: '/primary',
        tableSchema: {
          columns: [{ name: 'student' }, { name: 'campus', null: [] }, { name: 'country' }],
          foreignKeys: [{
            columnReference: ['campus', 'country'],
            reference: { resource: 'tables/campuses.csv', columnReference: ['code', 'country'] },
          }],
        },
      },
      {
        url: '/tables/campuses.csv',
        tableSchema: {
          columns: [{ name: 'code' }, { name: 'country' }],
          primaryKey: ['code', 'country'],
        },
      },
    ],
  };
  const { acquire } = sourceFor({
    '/primary': primary,
    '/tables/campuses.csv': campuses,
  });
  const result = await courierTableGroup({
    source: 'http://source.test', path: '/metadata', acquire,
    bytes: Buffer.from(JSON.stringify(document)),
  });
  const empty = result.delivery.blocked.find(row => row.table === 'primary' && row.row === 2);
  assert.equal(empty.reasons[0].code, 'dangling_reference');
  assert.deepEqual(empty.references[0].values, ['', 'CN']);
});

test('结构不可读的成员留在表组中并说明原因，不伪装成空表', async () => {
  const group = parseTableGroup(metadata, base);
  const specs = planTableGroup(group);
  const ragged = readTableMember(specs[1], Buffer.from('code,country,project\nc1,CN\n'));
  assert.equal(ragged.status, 'invalid');
  assert.deepEqual(ragged.issues.map(issue => issue.code), ['csv_ragged_rows']);
  assert.deepEqual(ragged.rows, []);
  const members = [readTableMember(specs[0], primary), ragged, readTableMember(specs[2], projects)];
  const evaluation = evaluateTableGroup({ group, members, source: 'http://source.test' });
  assert.equal(evaluation.state, 'invalid');
  assert.deepEqual(evaluation.memberIssues.map(issue => issue.code), ['csv_ragged_rows']);
  assert.equal(evaluation.delivery.ready.some(row => row.table === 'campuses'), false);
  for (const row of evaluation.delivery.blocked.filter(item => item.table === 'primary')) {
    assert.equal(row.references[0].status, 'invalid');
    assert.equal(row.references[0].reason.code, 'reference_member_invalid');
  }
});

test('指向其他来源的外键目标被拒绝，而不是默默请求', async () => {
  const document = {
    tables: [{
      url: '/primary',
      tableSchema: {
        columns: [{ name: 'student' }, { name: 'campus' }, { name: 'country' }],
        foreignKeys: [{
          columnReference: 'student',
          reference: { resource: 'http://other.test/students.csv', columnReference: 'id' },
        }],
      },
    }],
  };
  const { acquire, requests } = sourceFor({ '/primary': primary });
  const result = await courierTableGroup({
    source: 'http://source.test', path: '/metadata', acquire,
    bytes: Buffer.from(JSON.stringify(document)),
  });
  assert.deepEqual(requests, ['http://source.test/primary']);
  assert.deepEqual(result.reasons, [{ code: 'reference_outside_source', kind: 'metadata', count: 2 }]);
  assert.equal(result.delivery.status, 'blocked');
});

test('表内重复行作为警告保留，全部可交付', async () => {
  const document = {
    tables: [{
      url: '/primary',
      tableSchema: { columns: [{ name: 'student' }, { name: 'campus' }] },
    }],
  };
  const unique = await courierTableGroup({
    source: 'http://source.test',
    path: '/metadata',
    acquire: sourceFor({ '/primary': Buffer.from('student,campus\ns1,c1\ns2,c2\n') }).acquire,
    bytes: Buffer.from(JSON.stringify(document)),
  });
  assert.equal(unique.delivery.status, 'ready');
  assert.equal(unique.delivery.summary.warnings, 0);
  const repeated = await courierTableGroup({
    source: 'http://source.test',
    path: '/metadata',
    acquire: sourceFor({ '/primary': Buffer.from('student,campus\ns1,c1\ns1,c1\n') }).acquire,
    bytes: Buffer.from(JSON.stringify(document)),
  });
  assert.equal(repeated.delivery.status, 'ready');
  assert.deepEqual(repeated.delivery.ready.map(row => row.warnings[0].rows), [[1, 2], [1, 2]]);
  assert.equal(repeated.delivery.summary.warnings, 2);
});

test('元数据位于子目录时相对链接依元数据基准解析，@base 可覆盖', async () => {
  const document = {
    '@context': 'http://www.w3.org/ns/csvw',
    tables: [
      { url: 'tables/campuses.csv', tableSchema: { columns: [{ name: 'code' }] } },
      { url: 'tables/projects.csv', tableSchema: { columns: [{ name: 'id' }] } },
    ],
  };
  const group = parseTableGroup(document, 'http://source.test/publish/meta/group.json');
  assert.deepEqual(group.tables.map(table => table.url), [
    'http://source.test/publish/meta/tables/campuses.csv',
    'http://source.test/publish/meta/tables/projects.csv',
  ]);
  const based = parseTableGroup({
    '@base': '/data/',
    tables: [{ url: 'tables/campuses.csv', tableSchema: { columns: [{ name: 'code' }] } }],
  }, 'http://source.test/publish/meta/group.json');
  assert.deepEqual(based.tables.map(table => table.url), [
    'http://source.test/data/tables/campuses.csv',
  ]);
  const cycles = parseTableGroup({
    tables: [
      { url: 'a.csv', tableSchema: { columns: [{ name: 'x' }], foreignKeys: [
        { columnReference: 'x', reference: { resource: 'b.csv', columnReference: 'y' } }] } },
      { url: 'b.csv', tableSchema: { columns: [{ name: 'y' }], foreignKeys: [
        { columnReference: 'y', reference: { resource: 'a.csv', columnReference: 'x' } }] } },
    ],
  }, 'http://source.test/meta.json');
  assert.deepEqual(planTableGroup(cycles).map(spec => spec.url), [
    'http://source.test/a.csv', 'http://source.test/b.csv',
  ]);
});

test('元数据基准指向其他来源时整体拒绝，不发出越界请求', async () => {
  assert.throws(() => parseTableGroup({
    '@base': 'http://elsewhere.test/',
    tables: [{ url: 'a.csv', tableSchema: { columns: [{ name: 'x' }] } }],
  }, 'http://source.test/meta.json'), /metadata_base_outside_source/);
  assert.throws(() => parseTableGroup({
    tables: [{ url: 'http://elsewhere.test/a.csv', tableSchema: { columns: [{ name: 'x' }] } }],
  }, 'http://source.test/meta.json'), /table_url_outside_source/);
});

test('表级 null 与 schema 级 null 依次继承，列声明优先', () => {
  const group = parseTableGroup({
    tables: [
      {
        url: 'a.csv',
        null: ['NA'],
        tableSchema: {
          columns: [{ name: 'x' }, { name: 'y', null: [] }],
        },
      },
      {
        url: 'b.csv',
        tableSchema: { null: ['NULL'], columns: [{ name: 'z' }] },
      },
      { url: 'c.csv', tableSchema: { columns: [{ name: 'w' }] } },
    ],
  }, 'http://source.test/meta.json');
  assert.deepEqual(group.tables[0].columns, [
    { name: 'x', null: ['NA'] },
    { name: 'y', null: [] },
  ]);
  assert.deepEqual(group.tables[1].columns, [{ name: 'z', null: ['NULL'] }]);
  assert.deepEqual(group.tables[2].columns, [{ name: 'w', null: [''] }]);
});
