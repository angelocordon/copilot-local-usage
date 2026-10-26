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

export function reportOptions({ by = 'model', limit = '30' } = {}) {
  if (!['model', 'session'].includes(by)) {
    throw new Error('--by must be model or session');
  }
  if (limit === 'all') return { by, limit: 0 };
  if (!/^\d+$/.test(String(limit)) || !Number.isSafeInteger(Number(limit))) {
    throw new Error('--limit must be a non-negative integer or all');
  }
  return { by, limit: Number(limit) };
}

export function readUsage(DatabaseSync, path, { start, end }, { by = 'model' } = {}) {
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
      ? "COALESCE(NULLIF(e.copilot_usage_model, ''), e.model)"
      : 'e.model';
    const cost = columns.has('total_nano_aiu') ? 'e.total_nano_aiu' : 'NULL';
    const sessionView = by === 'session';
    if (sessionView && !columns.has('session_id')) {
      throw new Error('Session reporting is unavailable: this database has no session_id usage data.');
    }
    const sessionColumns = new Set(
      db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name),
    );
    const joinSessions = sessionView && sessionColumns.has('id');
    const metadata = (column) => joinSessions && sessionColumns.has(column) ? `s.${column}` : 'NULL';
    const group = sessionView ? 'e.session_id' : model;
    const identity = sessionView
      ? `e.session_id AS sessionId,
         ${metadata('summary')} AS summary,
         ${metadata('repository')} AS repository,
         ${metadata('branch')} AS branch,
         MIN(e.created_at) AS start`
      : `${model} AS model`;
    // Compare date prefixes to handle both SQLite and ISO timestamps.
    return db
      .prepare(
        `SELECT ${identity},
                COUNT(*) AS calls,
                SUM(COALESCE(e.output_tokens, 0)) AS outputTokens,
                COUNT(e.output_tokens) AS callsWithOutputTokens,
                SUM(${cost}) / 1000000000.0 AS credits,
                COUNT(${cost}) AS callsWithCost
         FROM assistant_usage_events e
         ${joinSessions ? 'LEFT JOIN sessions s ON s.id = e.session_id' : ''}
         WHERE substr(e.created_at, 1, 10) >= ?
           AND substr(e.created_at, 1, 10) < ?
         GROUP BY ${group}
         ORDER BY ${sessionView ? 'credits DESC, calls DESC, sessionId' : 'calls DESC, model'}`,
      )
      .all(start, end)
      .map((row) => ({
        ...(sessionView ? {
          sessionId: row.sessionId,
          summary: row.summary,
          repository: row.repository,
          branch: row.branch,
          start: row.start,
        } : { model: String(row.model) }),
        calls: Number(row.calls),
        outputTokens: Number(row.outputTokens),
        callsWithOutputTokens: Number(row.callsWithOutputTokens),
        credits: row.credits === null ? null : Number(row.credits),
        callsWithCost: Number(row.callsWithCost),
      }));
  } finally {
    db.close();
  }
}

function compact(value, max) {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

export function formatReport(rows, month, path, options = {}) {
  const { by, limit } = reportOptions(options);
  const sessionView = by === 'session';
  const fmt = (n) => n.toLocaleString('en-US');
  const decimal = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const costs = (r) => r.credits == null ? ['N/A', 'N/A'] : [decimal(r.credits), `$${decimal(r.credits * 0.01)}`];
  const lines = [`Copilot local usage - ${month} (UTC)`, `Database: ${path}`, ''];

  if (rows.length === 0) {
    lines.push('No recorded model calls for this month.');
  } else {
    const totals = {
      calls: rows.reduce((sum, r) => sum + r.calls, 0),
      outputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
      credits: rows.some((r) => r.credits != null)
        ? rows.reduce((sum, r) => sum + (r.credits ?? 0), 0) : null,
    };
    const headers = sessionView
      ? ['Session', 'ID', 'Repository', 'Start (UTC)', 'Recorded calls', 'AI credits', 'Est. USD']
      : ['Model', 'Recorded calls', 'Output tokens', 'AI credits', 'Est. USD'];
    const visible = sessionView && limit ? rows.slice(0, limit) : rows;
    const body = visible.map((r) => sessionView ? [
      compact(r.summary?.split(/\r?\n/)[0], 48) ||
        compact([r.repository, r.branch].filter(Boolean).join(' / '), 48) ||
        compact(r.sessionId, 12) || '(unknown session)',
      compact(r.sessionId, 12) || 'N/A',
      compact(r.repository, 32) || 'N/A',
      String(r.start).slice(0, 10),
      fmt(r.calls),
      ...costs(r),
    ] : [compact(r.model, 60), fmt(r.calls), fmt(r.outputTokens), ...costs(r)]);
    const total = sessionView
      ? ['TOTAL', '', '', '', fmt(totals.calls), ...costs(totals)]
      : ['TOTAL', fmt(totals.calls), fmt(totals.outputTokens), ...costs(totals)];
    const widths = headers.map((h, i) => Math.max(h.length, ...[...body, total].map((r) => r[i].length)));
    const textColumns = sessionView ? 4 : 1;
    const line = (r) => r.map((cell, i) => i < textColumns ? cell.padEnd(widths[i]) : cell.padStart(widths[i])).join('  ');
    const separator = widths.map((w) => '-'.repeat(w)).join('  ');

    lines.push(line(headers), separator, ...body.map(line), separator, line(total));
    if (visible.length < rows.length) {
      lines.push('', `Showing ${fmt(visible.length)} of ${fmt(rows.length)} sessions; TOTAL includes all sessions. Use --limit all to show every session.`);
    }

    const missingCost = rows.reduce((sum, r) => sum + r.calls - (r.callsWithCost ?? 0), 0);
    if (missingCost) {
      lines.push('', `Note: ${fmt(missingCost)} calls have no cost data; credits and estimates include only recorded values (N/A when unavailable).`);
    }

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
    'Estimated cost from local records: 1 AI credit = $0.01 USD.',
    'Plan discounts and included allowances are not reflected; not account-wide usage.',
    'One user prompt can trigger multiple model calls. GitHub billing is authoritative for charges.',
  );
  return lines.join('\n');
}
