export function csvRows(text, delimiter = ',') {
  const rows = []; let row = []; let field = ''; let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset];
    if (char === '"') {
      if (quoted && text[offset + 1] === '"') { field += '"'; offset++; }
      else if (quoted || !field) quoted = !quoted;
      else throw new Error('csv_quote_position');
    } else if (char === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[offset + 1] === '\n') offset++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error('csv_unclosed_quote');
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
export function inspect(bytes) {
  const rows = csvRows(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (!rows.length || !rows[0].length) throw new Error('csv_header_required');
  const width = rows[0].length;
  if (rows.some(row => row.length !== width)) throw new Error('csv_ragged_rows');
  return { kind: 'single-table', columns: rows[0], rows: rows.slice(1) };
}
