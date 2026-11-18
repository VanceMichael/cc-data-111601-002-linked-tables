import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const intake = async path => {
  const response = await fetch(`${service.url}/intakes`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
  if (response.status !== 201) throw new Error(await response.text());
  return response.json();
};
const summarize = record => ({
  id: record.id, kind: record.kind, status: record.status,
  tables: record.report.tables.map(table => ({
    url: table.url.replace(provider.url, ''), acquired: table.acquired,
    rows: table.rowCount, usable: table.usableCount, blocked: table.blockedCount
  })),
  records: record.report.records.map(entry =>
    ({ table: entry.table.replace(provider.url, ''), row: entry.row, key: entry.key })),
  blocked: record.report.blocked.map(entry => ({
    reason: entry.code, table: entry.table?.replace(provider.url, ''), row: entry.row,
    target: entry.target?.replace(provider.url, ''), rows: entry.rows
  })),
  notAcquired: record.report.notAcquired.map(entry =>
    ({ url: entry.url.replace(provider.url, ''), code: entry.code }))
});
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());

  // One entry point: the metadata document pulls in every referenced member.
  const complete = await intake('/metadata');
  console.log('完整表组', JSON.stringify(summarize(complete), null, 1));

  // Source phase 1 makes projects.csv unreachable: the group is still saved,
  // the missing member and the rows that depend on it are reported separately.
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const incomplete = await intake('/metadata');
  console.log('缺表时', JSON.stringify(summarize(incomplete), null, 1));
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 0 }) });

  // A plain CSV still uses the unchanged single-item contract.
  const single = await intake('/primary');
  console.log('单件资料', JSON.stringify({ kind: single.parsed.kind, digest: single.digest }));

  const records = await (await fetch(`${service.url}/records`)).json();
  console.log('已保存资料', JSON.stringify(records.map(record =>
    ({ id: record.id, kind: record.kind ?? 'single-table', status: record.status }))));
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
