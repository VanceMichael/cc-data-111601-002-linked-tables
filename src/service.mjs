import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { acquire } from './transport.mjs';
import { inspect } from './reader.mjs';
import { acquireTableGroup } from './group.mjs';
import { startProvider } from './provider.mjs';

function summarize(record) {
  if (record.kind !== 'table-group') return record;
  const { report } = record;
  const reasons = {};
  for (const item of report.blocked) {
    reasons[item.code] = (reasons[item.code] ?? 0) + 1;
  }
  return {
    id: record.id,
    kind: record.kind,
    source: record.source,
    fingerprint: record.fingerprint,
    status: record.status,
    entry: record.entry,
    bytes: record.bytes,
    artifacts: record.artifacts,
    counts: {
      tables: report.tables.length,
      acquired: report.tables.filter(table => table.acquired).length,
      records: report.records.length,
      blocked: report.blocked.length,
      notAcquired: report.notAcquired.length
    },
    // The listing itself discloses missing members and why rows were withheld;
    // GET /records/{id} carries the per-row detail.
    notAcquired: report.notAcquired,
    blockedReasons: reasons
  };
}

export async function startService({ source, directory, port = 0 }) {
  const store = await new Store(directory).initialize();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true }));
      if (url.pathname === '/records' && request.method === 'GET') {
        return response.end(JSON.stringify((await store.list()).map(summarize)));
      }
      if (url.pathname.startsWith('/records/') && request.method === 'GET') {
        const id = url.pathname.slice(9);
        const record = (await store.list()).find(item => item.id === id);
        if (!record) { response.writeHead(404); return response.end(JSON.stringify({ error: 'not_found' })); }
        return response.end(JSON.stringify(record));
      }
      if (url.pathname.startsWith('/objects/') && request.method === 'GET') {
        response.setHeader('Content-Type', 'application/octet-stream');
        return response.end(await store.object(url.pathname.slice(9)));
      }
      if (url.pathname === '/intakes' && request.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > 16384) throw new Error('request_too_large');
          chunks.push(chunk);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        if (typeof payload.path !== 'string') throw new Error('path_required');
        const result = await acquire(source, payload.path);
        // A CSVW table-group entry acquires its members as one record; a plain
        // CSV keeps the existing single-item contract.
        const group = await acquireTableGroup({
          source,
          entryPath: payload.path,
          entry: result,
          fetchResource: (base, path) => acquire(base, path)
        });
        if (group) {
          const record = await store.acceptGroup(group.report, group.artifacts,
            new URL(payload.path, source).href);
          response.statusCode = 201;
          return response.end(JSON.stringify(record));
        }
        const parsed = inspect(result.bytes);
        const record = await store.accept(result.bytes, new URL(payload.path, source).href, parsed);
        response.statusCode = 201;
        return response.end(JSON.stringify(record));
      }
      response.writeHead(404); response.end(JSON.stringify({ error: 'not_found' }));
    } catch (error) { response.statusCode = 422; response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { server, store, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const provider = process.env.SOURCE_URL ? null : await startProvider();
  const source = process.env.SOURCE_URL ?? provider.url;
  let service;
  try {
    service = await startService({ source, directory: process.env.DATA_DIR ?? './data',
      port: Number(process.env.PORT ?? 4102) });
  } catch (error) {
    if (provider) await provider.close();
    throw error;
  }
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await service.close();
    if (provider) await provider.close();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  console.log(JSON.stringify({ product: service.url, source }));
}
