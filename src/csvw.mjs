// CSVW table-group subset used by the exchange source.  This module only
// interprets metadata; it never fetches resources.  Keeping URL resolution and
// schema normalisation separate makes the publication conventions testable
// without a live source.

const DEFAULT_NULL = [''];

export function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textList(value) {
  return asList(value).map(item => String(item));
}

function nullList(value, fallback) {
  if (value === undefined) return fallback;
  return textList(value);
}

function issue(code, details = {}) {
  return { code, ...details };
}

function normalizeColumn(raw, inheritedNull, tableIndex, columnIndex, issues) {
  if (typeof raw === 'string') {
    return { name: raw, null: inheritedNull };
  }
  if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') {
    issues.push(issue('column_name_required', { tableIndex, columnIndex }));
    return null;
  }
  const declaredNull = Object.hasOwn(raw, 'null')
    ? nullList(raw.null, DEFAULT_NULL)
    : inheritedNull;
  return { name: raw.name, null: declaredNull };
}

function normalizeReference(reference, base, tableIndex, foreignKeyIndex, issues) {
  const details = { tableIndex, foreignKeyIndex };
  const target = reference && typeof reference === 'object' ? reference : {};
  let resource = null;
  if (typeof target.resource === 'string' && target.resource) {
    try { resource = new URL(target.resource, base).href; }
    catch { issues.push(issue('reference_resource_invalid', details)); }
  } else if (typeof target.schemaReference === 'string') {
    issues.push(issue('reference_schema_unsupported', details));
  } else {
    issues.push(issue('reference_resource_required', details));
  }
  return { resource, columns: textList(target.columnReference) };
}

function normalizeTable(raw, base, tableIndex, issues) {
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !raw.url) {
    issues.push(issue('table_url_required', { tableIndex }));
    return { index: tableIndex, url: null, columns: [], primaryKey: [], foreignKeys: [] };
  }
  let url = null;
  try { url = new URL(raw.url, base).href; }
  catch { issues.push(issue('table_url_invalid', { tableIndex, url: raw.url })); }

  const schema = raw.tableSchema;
  if (schema !== undefined && schema !== null && typeof schema !== 'object') {
    issues.push(issue('table_schema_unsupported', { tableIndex }));
  }
  const schemaObject = schema && typeof schema === 'object' ? schema : {};
  const inheritedNull = nullList(schemaObject.null, DEFAULT_NULL);
  const columns = [];
  if (Array.isArray(schemaObject.columns)) {
    schemaObject.columns.forEach((column, columnIndex) => {
      const normalized = normalizeColumn(column, inheritedNull, tableIndex, columnIndex, issues);
      if (normalized) columns.push(normalized);
    });
  }

  const foreignKeys = asList(schemaObject.foreignKeys).map((foreignKey, foreignKeyIndex) => {
    const details = { tableIndex, foreignKeyIndex };
    if (!foreignKey || typeof foreignKey !== 'object') {
      issues.push(issue('foreign_key_required', details));
      return { index: foreignKeyIndex, columns: [], reference: { resource: null, columns: [] } };
    }
    const columnsInKey = textList(foreignKey.columnReference);
    const reference = normalizeReference(foreignKey.reference, base, tableIndex, foreignKeyIndex, issues);
    if (!columnsInKey.length) issues.push(issue('foreign_key_columns_required', details));
    if (!reference.columns.length) issues.push(issue('reference_columns_required', details));
    if (columnsInKey.length && reference.columns.length
      && columnsInKey.length !== reference.columns.length) {
      issues.push(issue('foreign_key_arity', details));
    }
    return { index: foreignKeyIndex, columns: columnsInKey, reference };
  });

  return {
    index: tableIndex,
    url,
    publishedUrl: raw.url,
    columns,
    primaryKey: textList(schemaObject.primaryKey),
    foreignKeys
  };
}

/**
 * Normalise the CSVW table-group subset into absolute URLs and column/key
 * definitions.  Relative table and reference URLs are resolved against the
 * metadata URL (or @base, when present), as required by the publication
 * convention for this exchange.
 */
export function normalizeTableGroup(document, metadataUrl) {
  if (!document || typeof document !== 'object'
    || !Array.isArray(document.tables) || !document.tables.length) {
    throw new Error('metadata_tables_required');
  }
  let base = metadataUrl;
  if (typeof document['@base'] === 'string') {
    base = new URL(document['@base'], metadataUrl).href;
  }
  const issues = [];
  const tables = document.tables.map((table, index) =>
    normalizeTable(table, base, index, issues));

  const seen = new Map();
  for (const table of tables) {
    if (!table.url) continue;
    const prior = seen.get(table.url);
    if (prior === undefined) { seen.set(table.url, table); continue; }
    const same = JSON.stringify({ columns: prior.columns, primaryKey: prior.primaryKey,
      foreignKeys: prior.foreignKeys }) === JSON.stringify({ columns: table.columns,
      primaryKey: table.primaryKey, foreignKeys: table.foreignKeys });
    // An identical repeat is redundant publication; a conflicting repeat is
    // an ambiguous publication and cannot be resolved by preferring one.
    issues.push(same
      ? issue('duplicate_table_declaration', {
        tableIndex: table.index, url: table.url, firstTableIndex: prior.index })
      : issue('table_declaration_conflict', {
        tableIndex: table.index, url: table.url, firstTableIndex: prior.index }));
  }
  if (!tables.length) issues.push(issue('tables_required'));
  return { base, tables, issues };
}

/**
 * Return a parsed CSVW table group when the response is metadata, or null when
 * the response is an ordinary CSV resource.  JSON responses that are not table
 * groups are rejected rather than being misread as a CSV header.
 */
export function tableGroupDocument(bytes, contentType = '') {
  const text = bytes.toString('utf8').replace(/^﻿/, '');
  const isJson = contentType.toLowerCase().includes('json');
  // A CSV header may legitimately start with '{'; only unparseable text that
  // is either served as JSON or opens like a JSON document is treated as
  // broken metadata rather than being misread as one CSV header.
  const looksLikeMetadata = isJson || /^\s*\{\s*"/.test(text);
  let document;
  try { document = JSON.parse(text); }
  catch (error) {
    if (looksLikeMetadata) throw new Error('metadata_json_invalid');
    return null;
  }
  if (!document || typeof document !== 'object' || !Array.isArray(document.tables)) {
    if (isJson) throw new Error('metadata_tables_required');
    return null;
  }
  return document;
}
