import { createHash } from 'node:crypto';
import { acquire as defaultAcquire } from './transport.mjs';
import {
  evaluateTableGroup,
  isTableGroupMetadata,
  isTableMetadataDocument,
  parseTableGroup,
  planTableGroup,
  readTableMember,
} from './group.mjs';

const MAX_MEMBERS = 256;

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseMetadata(bytes) {
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function memberPath(url) {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function sourceError(error) {
  const code = String(error?.message || error?.name || 'source_error');
  const detail = error?.cause?.message;
  return { code, message: detail ? `${code}: ${detail}` : code };
}

// A member that could not be obtained keeps its place in the group and its
// reason for being absent. It is never replaced with an empty table, because
// that would turn "not obtained yet" into "no matching row". Rejected members
// are retained on the result but carry no transport detail.
function unavailableMember(spec, error, status = 'unavailable') {
  const info = status === 'rejected'
    ? { code: String(error?.message || 'outside_source'), message: String(error?.message || 'outside_source') }
    : sourceError(error);
  return {
    url: spec.url,
    metadataUrl: spec.metadataUrl ?? null,
    name: spec.name,
    declared: spec.declared,
    status,
    digest: null,
    bytes: null,
    columns: null,
    rows: [],
    rowCount: 0,
    primaryKey: spec.primaryKey ?? null,
    foreignKeys: spec.foreignKeys ?? [],
    notes: [...(spec.notes ?? [])],
    issues: [{ code: info.code, message: info.message, kind: status === 'rejected' ? 'metadata' : 'pending' }],
    duplicateRows: [],
    duplicateKeys: [],
    _spec: spec,
    _index: new Map(),
    _columnNull: new Map(),
  };
}

// Fetch a metadata document and every member needed by its references. The
// member list is built from metadata first and then from foreign-key targets,
// with each URL visited once, so a cyclic reference graph is fetched once.
export async function courierTableGroup({ source, path, bytes, metadataUrl, acquire = defaultAcquire }) {
  const origin = new URL(source);
  const documentUrl = new URL(metadataUrl ?? path, origin);
  if (documentUrl.origin !== origin.origin) throw new Error('outside_source');
  const artifacts = [];
  let metadataBytes = bytes;
  if (metadataBytes === undefined) {
    const acquired = await acquire(source, documentUrl.href);
    metadataBytes = acquired.bytes;
  }
  artifacts.push({ url: documentUrl.href, digest: digestOf(metadataBytes), bytes: metadataBytes });
  const metadata = parseMetadata(metadataBytes);
  if (!isTableGroupMetadata(metadata) && !isTableMetadataDocument(metadata)) {
    throw new Error('metadata_tables_required');
  }
  const group = parseTableGroup(metadata, documentUrl.href);
  const specs = planTableGroup(group);
  if (specs.length > MAX_MEMBERS) throw new Error('table_group_too_large');
  const members = [];
  for (const spec of specs) {
    const url = new URL(spec.url);
    if (url.origin !== origin.origin) {
      members.push(unavailableMember(spec,
        new Error('outside_source'), 'rejected'));
      continue;
    }
    let acquired;
    try {
      acquired = await acquire(source, spec.url);
    } catch (error) {
      members.push(unavailableMember(spec, error));
      continue;
    }
    const member = readTableMember(spec, acquired.bytes);
    members.push(member);
    if (!artifacts.some(artifact => artifact.url === member.url)) {
      artifacts.push({ url: member.url, digest: member.digest, bytes: acquired.bytes });
    }
  }
  const evaluation = evaluateTableGroup({ group, members, source });
  const result = {
    kind: 'table-group',
    source: origin.href,
    entry: documentUrl.href,
    metadata: {
      url: documentUrl.href,
      digest: digestOf(metadataBytes),
      bytes: metadataBytes.length,
      base: group.base,
    },
    group: { tables: group.tables.length, base: group.base },
    ...evaluation,
    documents: artifacts.map(artifact => ({
      url: artifact.url,
      digest: artifact.digest,
      bytes: artifact.bytes.length,
      path: memberPath(artifact.url),
    })),
  };
  Object.defineProperty(result, 'artifacts', { value: artifacts, enumerable: false });
  return result;
}

// Convenience wrapper used by callers that want serializable results plus the
// raw bytes for persistence.
export class TableCourier {
  constructor({ source, acquire = defaultAcquire } = {}) {
    if (!source) throw new Error('source_required');
    this.source = source;
    this.acquire = acquire;
  }
  async collect(path, options = {}) {
    const result = await courierTableGroup({
      source: this.source,
      path,
      acquire: this.acquire,
      ...options,
    });
    return result;
  }
}
