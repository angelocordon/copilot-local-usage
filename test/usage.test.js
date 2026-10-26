import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { formatReport, monthBounds, readUsage } from '../src/usage.js';

let dir;
let dbPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'copilot-usage-'));
  dbPath = join(dir, 'usage #test.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE assistant_usage_events (model TEXT, copilot_usage_model TEXT, created_at TEXT, output_tokens INTEGER)',
  );
  const insert = db.prepare('INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?)');
  insert.run('raw', 'billed', '2026-10-01T00:00:00Z', 10);
  insert.run('raw', 'billed', '2026-10-31 23:59:59', null);
  insert.run('fallback', null, '2026-10-15 10:00:00', 20);
  insert.run('excluded', null, '2026-11-01 00:00:00', 99);
  insert.run('excluded', null, '2026-09-30 23:59:59', 99);
  db.close();
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('monthBounds handles year rollover and rejects bad input', () => {
  assert.deepEqual(monthBounds('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  for (const bad of ['2026-13', '2026-00', '2026-1', 'garbage']) {
    assert.throws(() => monthBounds(bad));
  }
});

test('readUsage groups by model within month bounds', () => {
  assert.deepEqual(readUsage(DatabaseSync, dbPath, monthBounds('2026-10')), [
    { model: 'billed', calls: 2, outputTokens: 10, callsWithOutputTokens: 1 },
    { model: 'fallback', calls: 1, outputTokens: 20, callsWithOutputTokens: 1 },
  ]);
  assert.deepEqual(readUsage(DatabaseSync, dbPath, monthBounds('2025-01')), []);
});

test('readUsage reports a missing database', () => {
  assert.throws(() => readUsage(DatabaseSync, join(dir, 'missing.db'), monthBounds('2026-10')), /not found/);
});

test('formatReport includes totals and missing-token note', () => {
  const output = formatReport(readUsage(DatabaseSync, dbPath, monthBounds('2026-10')), '2026-10', dbPath);
  assert.match(output, /TOTAL\s+3\s+30/);
  assert.match(output, /1 calls have no output-token data/);
});

test('CLI prints a report without warnings', () => {
  const bin = new URL('../bin/copilot-local-usage.js', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [bin, '--month', '2026-10', '--db', dbPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /billed\s+2\s+10/);
});
