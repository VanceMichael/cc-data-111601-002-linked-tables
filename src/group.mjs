import { createHash } from 'node:crypto';
import { inspect } from './reader.mjs';

const DEFAULT_NULL = [''];

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function linkValue(value) {
  if (typeof value === 'string') return value;
  if (objectValue(value)) {
    if (typeof value['@id'] === 'string') return value['@id'];
    if (typeof value.url === 'string') return value.url;
  }
  return null;
}

function listValue(value) {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value.slice() : [value];
}

function nullValue(value) {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : [value];
  return items.map(item => String(item));
}

function columnList(value) {
  const items = listValue(value);
  if (items === null) return null;
  const names = [];
  for (const item of items) {
    const name = textValue(item) ?? linkValue(item);
    if (name === null || name === '') return null;
    names.push(name);
  }
  return names;
}

function resolveUrl(value, base, code) {
  try {
    const url = new URL(value, base);
    url.hash = '';
    return url;
  } catch {
    throw new Error(code);
  }
}

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isTableGroupMetadata(value) {
  return objectValue(value) && Array.isArray(value.tables) && value.tables.length > 0;
}

// A CSVW table metadata document describes a single table with `url`; the
// exchange accepts it as a one-table group so the same intake path works.
export function isTableMetadataDocument(value) {
  return objectValue(value) && !Array.isArray(value.tables)
    && typeof value.url === 'string' && objectValue(value.tableSchema);
}

function groupTables(metadata) {
  if (isTableGroupMetadata(metadata)) return metadata.tables;
  if (isTableMetadataDocument(metadata)) return [metadata];
  return null;
}

export function looksLikeTableMetadata(bytes) {
  const text = bytes.toString('utf8').replace(/^﻿/, '').trimStart();
  if (!text.startsWith('{')) return false;
  try {
    const value = JSON.parse(text);
    return isTableGroupMetadata(value) || isTableMetadataDocument(value);
  } catch {
    return false;
  }
}

function tableName(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1] || url;
    const decoded = decodeURIComponent(last);
    return decoded.replace(/\.(csv|json)$/i, '') || decoded;
  } catch {
    return url;
  }
}

function nameColumns(rawColumns, inheritedNull) {
  return rawColumns.map((column, index) => {
    if (!objectValue(column)) throw new Error('metadata_column_invalid');
    const title = listValue(column.titles)
      ?.map(textValue)
      .find(value => value !== null);
    const name = textValue(column.name) ?? title ?? `column_${index + 1}`;
    const ownNull = nullValue(column.null);
    return { name, null: ownNull ?? inheritedNull };
  });
}

function parseForeignKeys(raw, base, tableUrl, notes) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    notes.push('foreignKeys_not_array');
    return [];
  }
  return raw.map((foreignKey, index) => {
    const unsupported = [];
    let broken = null;
    const columns = columnList(foreignKey?.columnReference);
    const reference = foreignKey?.reference;
    let resource = null;
    let targetColumns = null;
    const resolve = value => {
      try { return resolveUrl(value, base, 'foreign_key_resource_invalid').href; }
      catch (error) { broken = error.message; return null; }
    };
    if (typeof reference === 'string') {
      if (reference.startsWith('#')) unsupported.push('fragment_reference');
      else resource = resolve(reference);
      targetColumns = columns;
    } else if (objectValue(reference)) {
      const linked = linkValue(reference.resource);
      if (linked === null || linked === '') resource = tableUrl;
      else if (linked.startsWith('#')) unsupported.push('fragment_reference');
      else resource = resolve(linked);
      // CSVW defaults the target columns to the foreign key's own columns.
      targetColumns = reference.columnReference === undefined
        ? columns
        : columnList(reference.columnReference);
      if (reference.schemaReference !== undefined) unsupported.push('schemaReference');
    } else {
      unsupported.push('reference');
    }
    const invalid = Boolean(broken) || unsupported.length > 0 || !columns || columns.length === 0;
    if (unsupported.length) notes.push('unsupported_foreign_key');
    if (broken) notes.push('foreign_key_resource_invalid');
    return {
      index,
      columnReference: columns,
      reference: { resource, columnReference: targetColumns, unsupported },
      invalid,
      error: broken ?? (unsupported.length ? 'foreign_key_unsupported'
        : invalid ? 'foreign_key_column_reference_required' : null),
    };
  });
}

// Parse the CSVW subset used by the exchange. Every relative link is resolved
// against the metadata document (or its @base), never against the caller's cwd.
export function parseTableGroup(metadata, metadataUrl) {
  const declaredTables = groupTables(metadata);
  if (!declaredTables) throw new Error('metadata_tables_required');
  const documentUrl = resolveUrl(metadataUrl, metadataUrl, 'metadata_url_invalid');
  const declaredBase = linkValue(metadata['@base']);
  const base = declaredBase === null
    ? documentUrl
    : resolveUrl(declaredBase, documentUrl, 'metadata_base_invalid');
  if (base.origin !== documentUrl.origin) throw new Error('metadata_base_outside_source');
  const groupNull = nullValue(metadata.null);
  const groupSchema = objectValue(metadata.tableSchema) ? metadata.tableSchema : null;
  const tables = [];

  for (const table of declaredTables) {
    if (!objectValue(table)) throw new Error('metadata_table_invalid');
    const linked = linkValue(table.url);
    if (linked === null || linked === '') throw new Error('table_url_required');
    const tableUrl = resolveUrl(linked, base, 'table_url_invalid');
    if (tableUrl.origin !== documentUrl.origin) throw new Error('table_url_outside_source');
    const ownSchema = objectValue(table.tableSchema) ? table.tableSchema : {};
    const tableSchema = groupSchema
      ? { ...groupSchema, ...Object.fromEntries(Object.entries(ownSchema)
        .filter(([, value]) => value !== undefined)) }
      : ownSchema;
    // Inherited null declarations: column, then schema, then table, then group.
    const inheritedNull = nullValue(tableSchema.null) ?? nullValue(table.null)
      ?? groupNull ?? DEFAULT_NULL;
    const columns = Array.isArray(tableSchema.columns) && tableSchema.columns.length
      ? nameColumns(tableSchema.columns, inheritedNull)
      : null;
    const notes = [];
    if (!columns) notes.push('table_schema_columns_missing');
    if (objectValue(table.dialect)) notes.push('dialect_not_applied');
    if (table.transformations !== undefined) notes.push('transformations_not_applied');
    if (tableSchema.rowTitles !== undefined) notes.push('rowTitles_not_applied');
    if (columns) {
      for (const column of tableSchema.columns) {
        if (column?.datatype !== undefined && textValue(column.datatype) !== 'string') {
          notes.push('datatype_not_coerced');
          break;
        }
      }
      const unsupportedColumn = tableSchema.columns.find(column =>
        objectValue(column) && ['separator', 'aboutUrl', 'propertyUrl', 'valueUrl']
          .some(key => column[key] !== undefined));
      if (unsupportedColumn) notes.push('column_virtual_properties_not_applied');
    }
    const primaryKey = tableSchema.primaryKey === undefined
      ? null
      : columnList(tableSchema.primaryKey);
    if (tableSchema.primaryKey !== undefined && (!primaryKey || !primaryKey.length)) {
      notes.push('primary_key_invalid');
    }
    const publishedName = listValue(table.titles)?.map(textValue)
      .find(value => value !== null);
    tables.push({
      url: tableUrl.href,
      metadataUrl: documentUrl.href,
      name: publishedName || tableName(tableUrl.href),
      declared: true,
      columns,
      defaultNull: inheritedNull,
      primaryKey: primaryKey?.length ? primaryKey : null,
      primaryKeyDeclared: tableSchema.primaryKey !== undefined,
      foreignKeys: parseForeignKeys(tableSchema.foreignKeys, base, tableUrl.href, notes),
      notes: [...new Set(notes)],
    });
  }
  return { url: documentUrl.href, base: base.href, tables };
}

// Expand the table group into the ordered set of documents that must be held
// before its references can be checked. Declared tables come first; foreign-key
// targets that were not declared in the metadata are followed as implicit
// members. A URL is visited once, so campus <-> project cycles terminate.
export function planTableGroup(group) {
  const specs = new Map();
  const order = [];
  const add = spec => {
    if (specs.has(spec.url)) return;
    specs.set(spec.url, spec);
    order.push(spec.url);
  };
  for (const table of group.tables) {
    add({ ...table, declared: true });
  }
  for (const table of group.tables) {
    for (const foreignKey of table.foreignKeys) {
      const url = foreignKey.reference.resource;
      if (url === null) continue;
      if (!specs.has(url)) {
        add({
          url,
          metadataUrl: group.url,
          name: tableName(url),
          declared: false,
          columns: null,
          defaultNull: DEFAULT_NULL,
          primaryKey: null,
          primaryKeyDeclared: false,
          foreignKeys: [],
          notes: ['implicit_member'],
        });
      }
    }
  }
  return order.map(url => specs.get(url));
}

function declaredColumnMap(table) {
  if (!table.columns) return undefined;
  const map = new Map();
  for (const column of table.columns) {
    if (map.has(column.name)) return null;
    map.set(column.name, column);
  }
  return map;
}

// Parse one member against its declared schema. Structural problems make the
// document unusable, but they stay locatable on the member instead of silently
// producing an empty table. Rows are kept in source order, including repeats.
export function readTableMember(spec, bytes) {
  const member = {
    url: spec.url,
    metadataUrl: spec.metadataUrl ?? null,
    name: spec.name,
    declared: spec.declared,
    status: 'acquired',
    digest: digestOf(bytes),
    bytes: bytes.length,
    columns: null,
    rows: [],
    rowCount: 0,
    primaryKey: spec.primaryKey ?? null,
    foreignKeys: spec.foreignKeys ?? [],
    notes: [...(spec.notes ?? [])],
    issues: [],
    duplicateRows: [],
    duplicateKeys: [],
    _index: new Map(),
    _columnNull: new Map(),
  };
  const invalid = (code, message = code, kind = 'metadata') => {
    member.status = 'invalid';
    member.issues.push({ code, message, kind });
    return member;
  };
  let parsed;
  try {
    parsed = inspect(bytes);
  } catch (error) {
    const code = String(error.message || 'csv_invalid');
    return invalid(code, `CSV member could not be read: ${code}`, 'data');
  }
  const columns = parsed.columns;
  const seen = new Set();
  for (const column of columns) {
    if (seen.has(column)) {
      return invalid('csv_duplicate_header', `duplicate column name: ${column}`, 'data');
    }
    seen.add(column);
  }
  const columnNull = new Map();
  const declared = declaredColumnMap(spec);
  if (declared === null) return invalid('metadata_duplicate_column', 'metadata declares the same column twice');
  if (declared) {
    for (const name of declared.keys()) {
      if (!seen.has(name)) {
        return invalid('metadata_column_missing', `declared column is absent from CSV: ${name}`);
      }
    }
    for (const column of columns) {
      if (!declared.has(column)) member.notes.push(`undeclared_column:${column}`);
      columnNull.set(column, declared.get(column)?.null ?? (spec.defaultNull ?? DEFAULT_NULL));
    }
    for (const name of spec.primaryKey ?? []) {
      if (!seen.has(name)) {
        return invalid('primary_key_column_missing', `primaryKey column is absent from CSV: ${name}`);
      }
    }
  } else {
    for (const column of columns) columnNull.set(column, DEFAULT_NULL);
  }
  for (const foreignKey of member.foreignKeys) {
    if (!foreignKey.columnReference) continue;
    const missing = foreignKey.columnReference.filter(column => !seen.has(column));
    if (missing.length) {
      foreignKey.invalid = true;
      foreignKey.error = 'foreign_key_column_missing';
      member.issues.push({
        code: 'foreign_key_column_missing',
        message: `foreign key columns are absent from CSV: ${missing.join(', ')}`,
        kind: 'metadata',
      });    }
  }
  const index = new Map();
  columns.forEach((name, position) => index.set(name, position));
  member.columns = columns;
  member.rows = parsed.rows;
  member.rowCount = parsed.rows.length;
  member._index = index;
  member._columnNull = columnNull;
  member.duplicateRows = duplicateRowGroups(parsed.rows);
  if (spec.primaryKey?.length) member.duplicateKeys = duplicateKeyGroups(member, spec.primaryKey);
  return member;
}

function duplicateRowGroups(rows) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const key = JSON.stringify(row);
    const group = groups.get(key);
    if (group) group.push(index + 1);
    else groups.set(key, [index + 1]);
  });
  return [...groups.values()].filter(rows => rows.length > 1)
    .map(rows => ({ rows, count: rows.length }));
}

function componentValue(member, row, column) {
  const position = member._index.get(column);
  if (position === undefined) return { ok: false, code: 'column_missing' };
  const value = row[position];
  const nulls = member._columnNull.get(column) ?? DEFAULT_NULL;
  return { ok: true, value, null: nulls.includes(value) };
}

function keyParts(member, row, columns) {
  const values = [];
  const nulls = [];
  for (const column of columns) {
    const part = componentValue(member, row, column);
    if (!part.ok) return { ok: false, code: part.code, column };
    values.push(part.value);
    if (part.null) nulls.push(column);
  }
  return { ok: true, values, nulls };
}

function duplicateKeyGroups(member, columns) {
  const groups = new Map();
  member.rows.forEach((row, index) => {
    const parts = keyParts(member, row, columns);
    if (!parts.ok || parts.nulls.length) return;
    const key = JSON.stringify(parts.values);
    const group = groups.get(key);
    if (group) group.push(index + 1);
    else groups.set(key, [index + 1]);
  });
  return [...groups.entries()].filter(([, rows]) => rows.length > 1)
    .map(([key, rows]) => ({ columns: [...columns], values: JSON.parse(key), rows, count: rows.length }));
}

function buildKeyIndex(member, columns) {
  const index = new Map();
  const missing = columns.filter(column => !member._index.has(column));
  if (missing.length) return { ok: false, code: 'reference_column_missing', missing };
  member.rows.forEach((row, position) => {
    const parts = keyParts(member, row, columns);
    if (!parts.ok || parts.nulls.length) return;
    const key = JSON.stringify(parts.values);
    const rows = index.get(key);
    if (rows) rows.push(position + 1);
    else index.set(key, [position + 1]);
  });
  return { ok: true, index };
}

function publicMember(member) {
  return {
    name: member.name,
    url: member.url,
    declared: member.declared,
    status: member.status,
    digest: member.digest ?? null,
    bytes: member.bytes ?? null,
    columns: member.columns,
    rowCount: member.rowCount,
    primaryKey: member.primaryKey,
    notes: member.notes,
    issues: member.issues,
    duplicateRows: member.duplicateRows,
    duplicateKeys: member.duplicateKeys,
    foreignKeys: member.foreignKeys.map(foreignKey => ({
      columnReference: foreignKey.columnReference,
      reference: foreignKey.reference,
      error: foreignKey.error ?? null,
    })),
  };
}

function reason(code, kind, message, details = {}) {
  return { code, kind, message, ...details };
}

// Check every row of every acquired member. A row is reported either as ready
// or as blocked with explicit reasons; nothing is dropped and duplicate keys
// are never resolved by Map overwrite.
export function evaluateTableGroup({ group, members, source }) {
  const memberByUrl = new Map(members.map(member => [member.url, member]));
  const keyIndexes = new Map();
  const keyIndexFor = (member, columns) => {
    const cacheKey = `${member.url}\u0000${columns.join('\u0000')}`;
    if (!keyIndexes.has(cacheKey)) keyIndexes.set(cacheKey, buildKeyIndex(member, columns));
    return keyIndexes.get(cacheKey);
  };
  const ready = [];
  const blocked = [];
  const reasons = [];
  const addReason = (target, item) => {
    target.push(item);
    reasons.push(item);
  };

  for (const member of members) {
    if (member.status !== 'acquired') continue;
    for (let position = 0; position < member.rows.length; position++) {
      const row = member.rows[position];
      const rowNumber = position + 1;
      const values = Object.fromEntries(member.columns.map((column, index) => [column, row[index]]));
      const rowReasons = [];
      const references = [];
      const warnings = [];
      if (member.duplicateRows.length) {
        const repeated = member.duplicateRows.find(group => group.rows.includes(rowNumber));
        if (repeated) {
          warnings.push(reason('duplicate_row', 'data', 'the same row values occur more than once', {
            rows: repeated.rows,
          }));
        }
      }
      if (member.primaryKey?.length) {
        const parts = keyParts(member, row, member.primaryKey);
        if (!parts.ok) {
          addReason(rowReasons, reason('primary_key_incomplete', 'metadata',
            `primary key column is unavailable: ${parts.column}`, { columns: member.primaryKey }));
        } else if (parts.nulls.length) {
          addReason(rowReasons, reason('primary_key_missing', 'data',
            `primary key contains null: ${parts.nulls.join(', ')}`, {
              columns: member.primaryKey, values: parts.values,
            }));
        } else {
          const groups = member.duplicateKeys.find(group =>
            group.rows.includes(rowNumber));
          if (groups) {
            addReason(rowReasons, reason('duplicate_primary_key', 'data',
              'the primary key occurs on more than one row', {
                columns: member.primaryKey, values: parts.values, rows: groups.rows,
              }));
          }
        }
      }
      for (const foreignKey of member.foreignKeys) {
        const reference = {
          foreignKey: foreignKey.index,
          columnReference: foreignKey.columnReference,
          resource: foreignKey.reference?.resource ?? null,
          targetColumnReference: foreignKey.reference?.columnReference ?? null,
          status: 'invalid',
          values: null,
          target: null,
          reason: null,
        };
        references.push(reference);
        if (foreignKey.invalid || !foreignKey.columnReference || !foreignKey.reference?.resource) {
          const item = reason('reference_invalid', 'metadata',
            foreignKey.error ?? 'foreign key declaration is incomplete', { foreignKey: foreignKey.index });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        const parts = keyParts(member, row, foreignKey.columnReference);
        if (!parts.ok) {
          const item = reason('reference_column_missing', 'metadata',
            `foreign key column is absent: ${parts.column}`, { foreignKey: foreignKey.index });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        reference.values = parts.values;
        if (parts.nulls.length) {
          reference.status = 'null_component';
          reference.reason = reason('null_reference_component', 'data',
            `no reference because a nullable component is null: ${parts.nulls.join(', ')}`, {
              foreignKey: foreignKey.index, columns: parts.nulls, values: parts.values,
            });
          // A composite reference with any nullable component absent yields no
          // reference at all; it is recorded, but it does not block the row.
          continue;
        }
        const targetUrl = foreignKey.reference.resource;
        let target;
        try { target = new URL(targetUrl); } catch { target = null; }
        if (!target || target.origin !== new URL(source).origin) {
          reference.status = 'rejected';
          const item = reason('reference_outside_source', 'metadata',
            'foreign key target is outside the configured source', {
              foreignKey: foreignKey.index, target: targetUrl, values: parts.values,
            });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        const targetMember = memberByUrl.get(targetUrl);
        if (!targetMember) {
          reference.status = 'pending';
          const item = reason('reference_unavailable', 'pending',
            'referenced table has not been obtained', {
              foreignKey: foreignKey.index, target: targetUrl, values: parts.values,
            });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        if (targetMember.status === 'unavailable' || targetMember.status === 'rejected') {
          reference.status = 'pending';
          const item = reason('reference_unavailable', 'pending',
            'referenced table has not been obtained', {
              foreignKey: foreignKey.index, target: targetUrl, values: parts.values,
              memberError: targetMember.issues?.[0]?.code ?? null,
            });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        if (targetMember.status !== 'acquired') {
          reference.status = 'invalid';
          const item = reason('reference_member_invalid', 'metadata',
            'referenced table was obtained but cannot be read', {
              foreignKey: foreignKey.index, target: targetUrl, values: parts.values,
            });
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        const targetColumns = foreignKey.reference?.columnReference;
        if (!targetColumns?.length) {
          const item = reason('reference_invalid', 'metadata',
            'foreign key does not name target columns', { foreignKey: foreignKey.index, target: targetUrl });
          reference.status = 'invalid';
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        const built = keyIndexFor(targetMember, targetColumns);
        if (!built.ok) {
          const item = reason('reference_column_missing', 'metadata',
            `referenced table lacks columns: ${built.missing.join(', ')}`, {
              foreignKey: foreignKey.index, target: targetUrl, columns: built.missing,
            });
          reference.status = 'invalid';
          reference.reason = item;
          addReason(rowReasons, item);
          continue;
        }
        const rows = built.index.get(JSON.stringify(parts.values)) ?? [];
        if (!rows.length) {
          reference.status = 'dangling';
          const item = reason('dangling_reference', 'data',
            'no row in the referenced table has this key', {
              foreignKey: foreignKey.index, target: targetUrl,
              columns: targetColumns, values: parts.values,
            });
          reference.reason = item;
          addReason(rowReasons, item);
        } else if (rows.length > 1) {
          reference.status = 'ambiguous';
          const item = reason('ambiguous_reference', 'data',
            'more than one row in the referenced table has this key', {
              foreignKey: foreignKey.index, target: targetUrl, columns: targetColumns,
              values: parts.values, rows,
            });
          reference.reason = item;
          addReason(rowReasons, item);
        } else {
          reference.status = 'resolved';
          reference.target = {
            name: targetMember.name, url: targetMember.url,
            row: rows[0], digest: targetMember.digest ?? null,
          };
        }
      }
      const record = {
        table: member.name,
        tableUrl: member.url,
        row: rowNumber,
        columns: member.columns,
        values,
        primaryKey: member.primaryKey,
        references,
        warnings,
        reasons: rowReasons,
      };
      if (rowReasons.length) blocked.push(record);
      else ready.push(record);
    }
  }

  const aggregate = new Map();
  for (const item of reasons) {
    const key = `${item.kind}\u0000${item.code}`;
    const entry = aggregate.get(key) ?? { code: item.code, kind: item.kind, count: 0 };
    entry.count++;
    aggregate.set(key, entry);
  }
  const unavailable = members
    .filter(member => member.status === 'unavailable' || member.status === 'rejected')
    .map(member => ({
      type: 'member', url: member.url, status: member.status,
      code: member.issues?.[0]?.code ?? 'member_unavailable',
      message: member.issues?.[0]?.message ?? 'member unavailable',
      kind: member.status === 'rejected' ? 'metadata' : 'pending',
    }));
  const memberIssues = members
    .filter(member => member.status === 'invalid')
    .map(member => ({
      type: 'member', url: member.url, status: member.status,
      code: member.issues?.[0]?.code ?? 'member_invalid',
      message: member.issues?.[0]?.message ?? 'member invalid',
      kind: member.issues?.[0]?.kind ?? 'metadata',
    }));
  const memberSummary = {
    total: members.length,
    acquired: members.filter(member => member.status === 'acquired').length,
    unavailable: members.filter(member => member.status === 'unavailable').length,
    rejected: members.filter(member => member.status === 'rejected').length,
    invalid: members.filter(member => member.status === 'invalid').length,
  };
  const status = ready.length && blocked.length ? 'partial'
    : blocked.length ? 'blocked'
      : ready.length ? 'ready' : 'empty';
  const state = memberSummary.rejected ? 'invalid'
    : memberSummary.unavailable ? 'incomplete'
      : memberSummary.invalid ? 'invalid' : 'complete';
  return {
    state,
    delivery: {
      status,
      ready,
      blocked,
      summary: {
        rows: ready.length + blocked.length,
        ready: ready.length,
        blocked: blocked.length,
        warnings: ready.concat(blocked).reduce((total, record) => total + record.warnings.length, 0),
      },
    },
    reasons: [...aggregate.values()].sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.code.localeCompare(right.code)),
    pending: unavailable,
    memberIssues,
    members: members.map(publicMember),
    memberSummary,
  };
}
