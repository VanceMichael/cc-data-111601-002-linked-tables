import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProvider } from '../src/provider.mjs';
import { startService } from '../src/service.mjs';
const directory = await mkdtemp(join(tmpdir(), 'intake-demo-'));
const provider = await startProvider();
const service = await startService({ source: provider.url, directory });
const intake = path => fetch(`${service.url}/intakes`, { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }) });
try {
  console.log(JSON.stringify({ source: provider.url, product: service.url }));
  console.log('来源目录', await (await fetch(`${provider.url}/catalog`)).json());
  const response = await intake('/metadata');
  if (response.status !== 201) throw new Error(await response.text());
  const record = await response.json();
  console.log('表组入口', record.entry);
  console.log('成员', record.members.map(member => ({
    name: member.name, status: member.status, rows: member.rowCount, digest: member.digest?.slice(0, 12),
  })));
  console.log('交付状态', { state: record.state, ...record.delivery.summary, reasons: record.reasons, pending: record.pending });
  console.log('可交付记录', record.delivery.ready.map(row => ({ table: row.table, row: row.row, values: row.values })));
  console.log('暂时不能交付', record.delivery.blocked.map(row => ({
    table: row.table, row: row.row, reasons: row.reasons.map(item => item.code),
  })));
  console.log('已保存资料', (await (await fetch(`${service.url}/records`)).json())
    .map(item => ({ kind: item.kind ?? 'single-table', state: item.state ?? 'n/a', id: item.id })));

  // A source that has not published one referenced table yet: the entry still
  // returns usable rows and names the unfinished part instead of an empty group.
  await fetch(`${provider.url}/_phase`, { method: 'POST', body: JSON.stringify({ phase: 1 }) });
  const delayed = await (await intake('/metadata')).json();
  console.log('阶段 1 交付状态', { state: delayed.state, ...delayed.delivery.summary,
    reasons: delayed.reasons, pending: delayed.pending });
} finally { await service.close(); await provider.close(); await rm(directory, { recursive: true, force: true }); }
