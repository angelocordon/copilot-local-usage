import { existsSync, statSync } from 'node:fs';

export function monthBounds(value) {
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error('month must be YYYY-MM (for example, 2026-10)');
  }
  const [year, month] = value.split('-').map(Number);
  if (month < 1 || month > 12) {
    throw new Error('month must be between 01 and 12');
  }
  const pad = (n) => String(n).padStart(2, '0');
  const start = `${year}-${pad(month)}-01`;
  const end = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  return { start, end };
}

export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export function readUsage(DatabaseSync, path, { start, end }) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(
      `Database not found: ${path}\nUse --db /path/to/session-store.db to select a local database.`,
    );
  }

  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const columns = new Set(
      db.prepare('PRAGMA table_info(assistant_usage_events)').all().map((row) => row.name),
    );
    if (!['model', 'created_at', 'output_tokens'].every((c) => columns.has(c))) {
      throw new Error(
        'This database has no compatible assistant_usage_events table. ' +
          'Your Copilot version may not record this usage or may use a different schema.',
      );
    }
    const model = columns.has('copilot_usage_model')
      ? "COALESCE(NULLIF(copilot_usage_model, ''), model)"
      : 'model';
    // Compare date prefixes to handle both SQLite and ISO timestamps.
    return db
      .prepare(
        `SELECT ${model} AS model,
                COUNT(*) AS calls,
                SUM(COALESCE(output_tokens, 0)) AS outputTokens,
                COUNT(output_tokens) AS callsWithOutputTokens
         FROM assistant_usage_events
         WHERE substr(created_at, 1, 10) >= ?
           AND substr(created_at, 1, 10) < ?
         GROUP BY ${model}
         ORDER BY calls DESC, model`,
      )
      .all(start, end)
      .map((row) => ({
        model: String(row.model),
        calls: Number(row.calls),
        outputTokens: Number(row.outputTokens),
        callsWithOutputTokens: Number(row.callsWithOutputTokens),
      }));
  } finally {
    db.close();
  }
}

export function formatReport(rows, month, path) {
  const fmt = (n) => n.toLocaleString('en-US');
  const lines = [`Copilot local usage - ${month} (UTC)`, `Database: ${path}`, ''];

  if (rows.length === 0) {
    lines.push('No recorded model calls for this month.');
  } else {
    const headers = ['Model', 'Recorded calls', 'Output tokens'];
    const body = rows.map((r) => [r.model, fmt(r.calls), fmt(r.outputTokens)]);
    const total = [
      'TOTAL',
      fmt(rows.reduce((sum, r) => sum + r.calls, 0)),
      fmt(rows.reduce((sum, r) => sum + r.outputTokens, 0)),
    ];
    const widths = headers.map((h, i) => Math.max(h.length, ...[...body, total].map((r) => r[i].length)));
    const line = (r) => [r[0].padEnd(widths[0]), r[1].padStart(widths[1]), r[2].padStart(widths[2])].join('  ');
    const separator = widths.map((w) => '-'.repeat(w)).join('  ');

    lines.push(line(headers), separator, ...body.map(line), separator, line(total));

    const missing = rows.reduce((sum, r) => sum + r.calls - r.callsWithOutputTokens, 0);
    if (missing) {
      lines.push(
        '',
        `Note: ${fmt(missing)} calls have no output-token data; token totals include only recorded values.`,
      );
    }
  }

  lines.push(
    '',
    'Local records only, not billed credits or account-wide usage.',
    'One user prompt can trigger multiple model calls. GitHub billing is authoritative for charges.',
  );
  return lines.join('\n');
}
