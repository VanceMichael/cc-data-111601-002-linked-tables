import { createHash } from 'node:crypto';
import { csvRows } from './reader.mjs';
import { normalizeTableGroup, tableGroupDocument } from './csvw.mjs';

const DEFAULT_NULL = [''];

// Issues that annotate a member or a row but do not, by themselves, stop the
// affected rows from being delivered.  Every other issue blocks rows or makes
// the group incomplete.
const WARNING_CODES = new Set([
  'columns_inferred_from_header',
  'duplicate_row',
  'table_not_declared',
  'duplicate_table_declaration'
]);
// Note: table_declaration_conflict is deliberately not a warning: it blocks
// every row published under the conflicting URL.

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isNullValue(column, value) {
  const declared = column ? column.null : DEFAULT_NULL;
  return declared.includes(value);
}

function parseCsv(bytes) {
  const rows = csvRows(bytes.toString('utf8').replace(/^﻿/, ''));
  if (!rows.length || !rows[0].length) throw new Error('csv_header_required');
  const header = rows[0];
  const width = header.length;
  if (rows.some(row => row.length !== width)) throw new Error('csv_ragged_rows');
  return { header, rows: rows.slice(1) };
}

function uniqueHeaderNames(header, url, issues) {
  const seen = new Set();
  header.forEach((name, index) => {
    if (seen.has(name)) {
      issues.push({ code: 'duplicate_column_name', table: url, columnIndex: index, column: name });
    }
    seen.add(name);
  });
}

/**
 * Interpret one acquired CSV member against its declared table definition.
 * Source text is preserved verbatim on every row; nulls, keys and references
 * are interpreted on top so the single-table read contract is not weakened.
 */
function interpretTable({ url, declared, definition, bytes, definitionIssues, contentType }) {
  const issues = [...definitionIssues];
  const base = {
    url, declared, acquired: true, digest: digestOf(bytes), bytes: bytes.length,
    columns: definition.columns.map(column => column.name),
    primaryKey: definition.primaryKey,
    foreignKeys: definition.foreignKeys,
    rowCount: 0, usableCount: 0, blockedCount: 0, rows: [], index: new Map()
  };
  if (String(contentType ?? '').toLowerCase().includes('json')) {
    return { ...base, status: 'invalid',
      issues: [...issues, { code: 'table_not_csv', table: url, contentType }] };
  }
  let parsed;
  try { parsed = parseCsv(bytes); }
  catch (error) {
    return { ...base, status: 'invalid', issues: [...issues, { code: error.message, table: url }] };
  }
  const { header, rows: rawRows } = parsed;
  uniqueHeaderNames(header, url, issues);
  const ambiguousHeader = issues.some(issue => issue.code === 'duplicate_column_name');

  let columns = definition.columns;
  if (!columns.length) {
    columns = header.map(name => ({ name, null: DEFAULT_NULL }));
    issues.push({ code: 'columns_inferred_from_header', table: url });
  }
  const positions = new Map();
  header.forEach((name, index) => { if (!positions.has(name)) positions.set(name, index); });
  const columnsByName = new Map();
  for (const column of columns) {
    if (!columnsByName.has(column.name)) columnsByName.set(column.name, column);
  }
  for (const column of columns) {
    if (!positions.has(column.name)) {
      issues.push({ code: 'column_not_in_source', table: url, column: column.name });
    }
  }
  const missingColumns = columns
    .filter(column => !positions.has(column.name))
    .map(column => column.name);

  const keyDeclarationInvalid = definition.primaryKey.length
    && definition.primaryKey.some(name => !columnsByName.has(name) || !positions.has(name));
  if (keyDeclarationInvalid) {
    issues.push({ code: 'primary_key_unknown_column', table: url, columns: definition.primaryKey });
  }

  const rows = rawRows.map((raw, offset) => {
    // Null-prototype storage: a header literally named __proto__ stays data.
    const values = Object.create(null);
    header.forEach((name, index) => {
      if (!Object.hasOwn(values, name)) values[name] = raw[index];
    });
    const row = {
      table: url, row: offset + 1, values, raw: [...raw],
      key: null, keyText: null, blocks: [], warnings: [], references: []
    };
    if (ambiguousHeader) {
      row.blocks.push({ code: 'duplicate_column_name' });
    }
    // A declared column the source does not publish leaves the record
    // unverifiable; it is withheld rather than delivered with a hole.
    if (missingColumns.length) {
      row.blocks.push({ code: 'column_not_in_source', columns: missingColumns });
    }
    if (definition.primaryKey.length) {
      if (keyDeclarationInvalid) {
        row.blocks.push({ code: 'primary_key_unknown_column', columns: definition.primaryKey });
      } else {
        const nullColumns = definition.primaryKey.filter(name =>
          !Object.hasOwn(values, name) || isNullValue(columnsByName.get(name), values[name]));
        if (nullColumns.length) {
          row.blocks.push({ code: 'null_primary_key', columns: nullColumns });
        } else {
          row.key = definition.primaryKey.map(name => values[name]);
          row.keyText = JSON.stringify(row.key);
        }
      }
    }
    return row;
  });

  // Duplicate source rows stay in place; only the fact is recorded.  No Map
  // lookup is allowed to collapse them.
  const bySignature = new Map();
  rows.forEach(row => {
    const signature = JSON.stringify(row.raw);
    if (!bySignature.has(signature)) bySignature.set(signature, []);
    bySignature.get(signature).push(row);
  });
  for (const group of bySignature.values()) {
    if (group.length < 2) continue;
    const rowNumbers = group.map(row => row.row);
    issues.push({ code: 'duplicate_row', table: url, rows: rowNumbers });
    for (const row of group) row.warnings.push({ code: 'duplicate_row', rows: rowNumbers });
  }

  // A duplicated key makes every row holding it ambiguous.  All copies are
  // retained and all are blocked; no first-wins or last-wins entry exists.
  const byKey = new Map();
  rows.forEach(row => {
    if (row.keyText === null) return;
    if (!byKey.has(row.keyText)) byKey.set(row.keyText, []);
    byKey.get(row.keyText).push(row);
  });
  for (const [keyText, group] of byKey) {
    if (group.length < 2) continue;
    const rowNumbers = group.map(row => row.row);
    const key = JSON.parse(keyText);
    issues.push({ code: 'duplicate_primary_key', table: url, key, rows: rowNumbers });
    for (const row of group) row.blocks.push({ code: 'duplicate_primary_key', key, rows: rowNumbers });
  }

  return { ...base, status: 'acquired', rowCount: rows.length,
    columns, columnsByName, positions, issues, rows };
}

/**
 * Index target rows by a reference column list.  All matching rows are kept,
 * so a duplicate key surfaces as ambiguity instead of overwriting an entry.
 */
function referenceIndex(table, columns) {
  const signature = JSON.stringify(columns);
  if (table.index.has(signature)) return table.index.get(signature);
  const index = new Map();
  for (const row of table.rows) {
    if (columns.some(name => !Object.hasOwn(row.values, name))) continue;
    const key = JSON.stringify(columns.map(name => row.values[name]));
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(row);
  }
  table.index.set(signature, index);
  return index;
}

function evaluateReferences(table, tables) {
  for (const row of table.rows) {
    for (const foreignKey of table.foreignKeys) {
      const reference = foreignKey.reference;
      const result = {
        fromTable: table.url, fromRow: row.row,
        columns: foreignKey.columns,
        values: foreignKey.columns.map(name => row.values[name] ?? null),
        target: reference.resource,
        targetColumns: reference.columns,
        status: 'resolved',
        targetRows: []
      };
      row.references.push(result);

      if (!foreignKey.columns.length || !reference.columns.length || !reference.resource) {
        result.status = 'invalid_declaration';
        row.blocks.push({ code: 'foreign_key_invalid_declaration' });
        continue;
      }
      if (foreignKey.columns.length !== reference.columns.length) {
        result.status = 'invalid_declaration';
        row.blocks.push({ code: 'foreign_key_arity', columns: foreignKey.columns,
          targetColumns: reference.columns });
        continue;
      }
      if (foreignKey.columns.some(name =>
        !table.columnsByName.has(name) || !table.positions.has(name))) {
        result.status = 'invalid_columns';
        row.blocks.push({ code: 'foreign_key_columns_unknown', columns: foreignKey.columns });
        continue;
      }
      const nullColumns = foreignKey.columns.filter(name =>
        isNullValue(table.columnsByName.get(name), row.values[name]));
      if (nullColumns.length) {
        // CSVW: any nullable component being null means the composite key
        // produces no reference.  This is an optional link, not a defect.
        result.status = 'optional';
        result.nullColumns = nullColumns;
        continue;
      }
      const target = tables.get(reference.resource);
      if (!target) {
        result.status = 'not_acquired';
        row.blocks.push({ code: 'reference_not_acquired', target: reference.resource,
          columns: foreignKey.columns });
        continue;
      }
      if (!target.acquired || target.status !== 'acquired') {
        result.status = 'target_unavailable';
        row.blocks.push({ code: 'reference_target_unavailable',
          target: reference.resource, targetCode: target.error });
        continue;
      }
      if (reference.columns.some(name =>
        !target.positions?.has(name) || !target.columnsByName.has(name))) {
        result.status = 'reference_columns_unknown';
        row.blocks.push({ code: 'reference_columns_unknown',
          target: reference.resource, columns: reference.columns });
        continue;
      }
      const key = JSON.stringify(foreignKey.columns.map(name => row.values[name]));
      const matches = referenceIndex(target, reference.columns).get(key) ?? [];
      result.targetRows = matches.map(match => ({ table: target.url, row: match.row }));
      if (!matches.length) {
        result.status = 'dangling';
        row.blocks.push({ code: 'reference_dangling', target: reference.resource,
          referenceValues: result.values });
      } else if (matches.length > 1) {
        result.status = 'ambiguous';
        row.blocks.push({ code: 'reference_ambiguous', target: reference.resource,
          referenceValues: result.values, rows: matches.map(match => match.row) });
      }
    }
  }
}

/**
 * A record is deliverable only when its own data is sound and every row it
 * resolves to is deliverable too.  Cycles in the reference graph are legal:
 * usability is the greatest fixed point of "no blocks and all resolved
 * targets usable".  Compute it by walking backwards from initially blocked
 * rows, so a defect anywhere in a cycle propagates to every member without
 * recursion and clean cycles stay usable.
 */
function computeUsability(rows) {
  const idOf = row => `${row.table}#${row.row}`;
  const dependants = new Map(rows.map(row => [idOf(row), []]));
  const usable = new Map();
  const queue = [];
  for (const row of rows) {
    if (row.blocks.length) { usable.set(idOf(row), false); queue.push(idOf(row)); }
    else usable.set(idOf(row), true);
  }
  for (const row of rows) {
    for (const reference of row.references) {
      if (reference.status !== 'resolved') continue;
      for (const target of reference.targetRows) {
        const targetId = `${target.table}#${target.row}`;
        if (!dependants.has(targetId)) continue;
        dependants.get(targetId).push(idOf(row));
      }
    }
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    for (const dependant of dependants.get(queue[cursor]) ?? []) {
      if (!usable.get(dependant)) continue;
      usable.set(dependant, false);
      queue.push(dependant);
    }
  }
  return { usable, idOf };
}

/**
 * Acquire the metadata entry and every table it declares or reaches through a
 * foreign key.  URLs are visited once, so legal cyclic references (the campus
 * and project tables reference each other) cannot loop.  A member that cannot
 * be fetched is recorded as not acquired and its dependants are blocked with
 * that reason, kept distinct from a dangling reference in fetched data.
 */
export async function acquireTableGroup({ source, entryPath, entry, fetchResource }) {
  const entryUrl = new URL(entryPath, source).href;
  const document = tableGroupDocument(entry.bytes, entry.headers?.['content-type'] ?? '');
  if (!document) return null;
  const group = normalizeTableGroup(document, entryUrl);

  const declared = new Map();
  for (const table of group.tables) {
    if (table.url && !declared.has(table.url)) declared.set(table.url, table);
  }

  // Members to acquire: everything the metadata declares, plus FK targets
  // that live in another directory or are not themselves declared.
  const requested = [];
  const add = url => { if (url && !requested.includes(url)) requested.push(url); };
  for (const table of group.tables) add(table.url);
  for (const table of group.tables) {
    for (const foreignKey of table.foreignKeys) add(foreignKey.reference.resource);
  }

  const artifacts = [{ url: entryUrl, role: 'metadata', digest: digestOf(entry.bytes),
    bytes: entry.bytes, contentType: entry.headers?.['content-type'] }];
  const members = new Map();
  for (const url of requested) {
    if (url === entryUrl) {
      members.set(url, { acquired: true, result: { bytes: entry.bytes, headers: entry.headers ?? {} } });
      continue;
    }
    try {
      const result = await fetchResource(source, url);
      members.set(url, { acquired: true, result });
      artifacts.push({ url, role: 'table', digest: digestOf(result.bytes), bytes: result.bytes,
        contentType: result.headers?.['content-type'] });
    } catch (error) {
      members.set(url, { acquired: false, error: error.message });
    }
  }

  const tables = new Map();
  for (const url of requested) {
    const definition = declared.get(url) ?? { url, columns: [], primaryKey: [], foreignKeys: [] };
    const member = members.get(url);
    if (!member?.acquired) {
      tables.set(url, {
        url, declared: declared.has(url), acquired: false, error: member?.error ?? 'not_acquired',
        columns: definition.columns.map(column => column.name),
        primaryKey: definition.primaryKey, foreignKeys: definition.foreignKeys,
        rowCount: 0, usableCount: 0, blockedCount: 0, status: 'not_acquired',
        issues: [], rows: [], index: new Map()
      });
      continue;
    }
    if (url === entryUrl) {
      // A table URL that points back at the metadata document is not a data
      // member; do not parse JSON as CSV.
      tables.set(url, {
        url, declared: declared.has(url), acquired: false, error: 'table_is_metadata',
        columns: definition.columns.map(column => column.name),
        primaryKey: definition.primaryKey, foreignKeys: definition.foreignKeys,
        rowCount: 0, usableCount: 0, blockedCount: 0, status: 'not_acquired',
        issues: [{ code: 'table_is_metadata', table: url }],
        rows: [], index: new Map()
      });
      continue;
    }
    tables.set(url, interpretTable({
      url,
      declared: declared.has(url),
      definition,
      bytes: member.result.bytes,
      contentType: member.result.headers?.['content-type'],
      definitionIssues: declared.has(url) ? [] : [{ code: 'table_not_declared', table: url }]
    }));
  }

  // A URL declared twice with different schemas cannot be interpreted from
  // any one of them; every row under that URL is withheld rather than having
  // one declaration silently chosen.
  const conflicting = new Set(group.issues
    .filter(issue => issue.code === 'table_declaration_conflict')
    .map(issue => issue.url));
  for (const url of conflicting) {
    const table = tables.get(url);
    if (!table || table.status !== 'acquired') continue;
    table.issues.push({ code: 'table_declaration_conflict', table: url });
    for (const row of table.rows) row.blocks.push({ code: 'table_declaration_conflict' });
  }

  for (const table of tables.values()) {
    if (table.status === 'acquired') evaluateReferences(table, tables);
  }

  const allRows = [...tables.values()].flatMap(table => table.rows);
  const { usable, idOf } = computeUsability(allRows);

  // Turn "usable only because a target is not" into an explicit reason.
  for (const row of allRows) {
    if (row.blocks.length || usable.get(idOf(row))) continue;
    for (const reference of row.references) {
      if (!['resolved'].includes(reference.status)) continue;
      const broken = reference.targetRows.filter(target =>
        !usable.get(`${target.table}#${target.row}`));
      if (!broken.length) continue;
      row.blocks.push({ code: 'reference_target_not_deliverable',
        target: reference.target, rows: broken.map(target => target.row) });
      break;
    }
  }

  const issues = [...group.issues];
  const records = [];
  const blocked = [];
  const references = [];
  for (const table of tables.values()) {
    for (const issue of table.issues) issues.push(issue);
    if (table.status !== 'acquired') continue;
    for (const row of table.rows) {
      const description = row.references.map(reference => ({
        target: reference.target,
        columns: reference.columns,
        targetColumns: reference.targetColumns,
        values: reference.values,
        status: reference.status,
        nullColumns: reference.nullColumns,
        targetRows: [...reference.targetRows]
      }));
      for (const reference of row.references) {
        references.push({ fromTable: table.url, fromRow: row.row, ...reference,
          targetRows: [...reference.targetRows] });
      }
      if (!usable.get(idOf(row)) || row.blocks.length) {
        table.blockedCount++;
        for (const block of row.blocks) {
          blocked.push({ table: table.url, row: row.row, key: row.key,
            values: row.values, warnings: row.warnings, ...block });
        }
        continue;
      }
      table.usableCount++;
      records.push({
        table: table.url,
        row: row.row,
        key: row.key,
        values: row.values,
        references: description,
        warnings: row.warnings
      });
    }
  }

  const notAcquired = [...tables.values()]
    .filter(table => !table.acquired)
    .map(table => ({ url: table.url, declared: table.declared, code: table.error }));
  const fatalIssues = issues.filter(issue => !WARNING_CODES.has(issue.code));
  const status = notAcquired.length || blocked.length || fatalIssues.length
    ? 'incomplete' : 'complete';

  const tableReports = [...tables.values()].map(table => ({
    url: table.url,
    declared: table.declared,
    acquired: table.acquired,
    status: table.status,
    error: table.error,
    digest: table.digest,
    bytes: table.bytes,
    columns: table.columns,
    primaryKey: table.primaryKey,
    rowCount: table.rowCount,
    usableCount: table.usableCount,
    blockedCount: table.blockedCount,
    issues: table.issues
  }));

  const fingerprint = digestOf(JSON.stringify({
    entry: entryUrl,
    metadata: digestOf(entry.bytes),
    members: tableReports
      .map(table => [table.url, table.digest ?? `error:${table.error}`])
      .sort(([left], [right]) => left.localeCompare(right))
  }));

  return {
    report: {
      kind: 'table-group',
      entry: entryUrl,
      status,
      fingerprint,
      metadata: {
        url: entryUrl,
        digest: digestOf(entry.bytes),
        bytes: entry.bytes.length,
        contentType: entry.headers?.['content-type'],
        issues: group.issues
      },
      tables: tableReports,
      notAcquired,
      blocked,
      records,
      references,
      issues
    },
    artifacts
  };
}
