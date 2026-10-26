import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { formatReport, monthBounds, readUsage, reportOptions } from '../src/usage.js';

let dir;
let dbPath;
let costDbPath;

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

  costDbPath = join(dir, 'costs.db');
  const costs = new DatabaseSync(costDbPath);
  costs.exec(`
    CREATE TABLE assistant_usage_events (
      model TEXT, created_at TEXT, output_tokens INTEGER,
      session_id TEXT, total_nano_aiu INTEGER
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, repository TEXT, branch TEXT);
    INSERT INTO sessions VALUES
      ('expensive', 'Fix the build
Ignore this second line', 'owner/repo', 'fix-build'),
      ('free', NULL, 'owner/free', 'main'),
      ('empty', NULL, NULL, NULL);
    INSERT INTO assistant_usage_events VALUES
      ('model-a', '2026-10-05T12:00:00Z', 10, 'expensive', 2000000000000),
      ('model-b', '2026-10-01 01:00:00', 20, 'expensive', 500000000000),
      ('model-a', '2026-10-07 00:00:00', NULL, 'orphan', 1000000000),
      ('model-a', '2026-10-08 00:00:00', 0, 'free', 0),
      ('model-a', '2026-10-09 00:00:00', 0, 'empty', NULL),
      ('model-a', '2026-10-10 00:00:00', 0, NULL, NULL),
      ('model-a', '2026-10-11 00:00:00', 0, 'expensive', NULL),
      ('model-a', '2026-09-30 23:59:59', 99, 'expensive', 999000000000000),
      ('model-a', '2026-11-01T00:00:00Z', 99, 'expensive', 999000000000000);
  `);
  costs.close();
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
    { model: 'billed', calls: 2, outputTokens: 10, callsWithOutputTokens: 1, credits: null, callsWithCost: 0 },
    { model: 'fallback', calls: 1, outputTokens: 20, callsWithOutputTokens: 1, credits: null, callsWithCost: 0 },
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
  assert.match(output, /3 calls have no cost data/);
  assert.match(output, /N\/A/);
});

test('CLI prints a report without warnings', () => {
  const bin = new URL('../bin/copilot-local-usage.js', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [bin, '--month', '2026-10', '--db', dbPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(output, /billed\s+2\s+10/);
});

test('report options validate grouping and limits', () => {
  assert.deepEqual(reportOptions(), { by: 'model', limit: 30 });
  for (const limit of ['0', 'all']) {
    assert.deepEqual(reportOptions({ by: 'session', limit }), { by: 'session', limit: 0 });
  }
  for (const limit of ['-1', '1.5', 'NaN', '', '9007199254740992']) {
    assert.throws(() => reportOptions({ limit }), /--limit/);
  }
  assert.throws(() => reportOptions({ by: 'invalid' }), /--by/);
});

test('session costs aggregate across models, sort by cost, and retain missing metadata', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'), { by: 'session' });
  assert.deepEqual(rows.map((r) => [r.sessionId, r.credits]), [
    ['expensive', 2500], ['orphan', 1], ['free', 0], [null, null], ['empty', null],
  ]);
  assert.equal(rows[0].calls, 3);
  assert.equal(rows[0].callsWithCost, 2);
  assert.equal(rows[0].start, '2026-10-01 01:00:00');
  assert.equal(rows[1].summary, null);
  const output = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 1 });
  assert.match(output, /Fix the build/);
  assert.doesNotMatch(output, /Ignore this second line/);
  assert.match(output, /2,500\.00\s+\$25\.00/);
  assert.match(output, /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
  assert.match(output, /Showing 1 of 5 sessions; TOTAL includes all sessions/);
  assert.match(output, /3 calls have no cost data/);
  const all = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 'all' });
  assert.match(all, /owner\/free \/ main/);
  assert.match(all, /\(unknown session\)/);
  assert.doesNotMatch(all, /Showing/);
  const many = Array.from({ length: 31 }, (_, i) => ({ ...rows[0], sessionId: `session-${i}` }));
  const limited = formatReport(many, '2026-10', costDbPath, { by: 'session' });
  assert.match(limited, /Showing 30 of 31 sessions/);
  assert.match(limited, /TOTAL\s+93\s+77,500\.00\s+\$775\.00/);
});

test('model report includes credits and USD estimates without changing call ordering', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'));
  assert.equal(rows[0].model, 'model-a');
  assert.equal(rows[0].credits, 2001);
  assert.equal(rows[1].credits, 500);
  assert.match(formatReport(rows, '2026-10', costDbPath), /TOTAL\s+7\s+30\s+2,501\.00\s+\$25\.01/);
});

test('older schemas retain session grouping without metadata or costs', () => {
  const path = join(dir, 'legacy-sessions.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE assistant_usage_events (
    model TEXT, created_at TEXT, output_tokens INTEGER, session_id TEXT
  );
  INSERT INTO assistant_usage_events VALUES ('model', '2026-10-01', 1, 'legacy-id');`);
  db.close();
  const rows = readUsage(DatabaseSync, path, monthBounds('2026-10'), { by: 'session' });
  assert.equal(rows[0].sessionId, 'legacy-id');
  assert.equal(rows[0].credits, null);
  assert.match(formatReport(rows, '2026-10', path, { by: 'session' }), /legacy-id\s+legacy-id\s+N\/A/);
  assert.throws(() => readUsage(DatabaseSync, dbPath, monthBounds('2026-10'), { by: 'session' }), /no session_id/);
});

test('session titles are truncated and terminal control characters are removed', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'), { by: 'session' });
  rows[0].summary = '\x1b[31m' + 'x'.repeat(100);
  const output = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 1 });
  assert.doesNotMatch(output, /\x1b/);
  assert.match(output, /x\.\.\./);
});

test('CLI supports session reports, unlimited output, help, and invalid options', () => {
  const bin = new URL('../bin/copilot-local-usage.js', import.meta.url).pathname;
  const run = (...args) => execFileSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const limit of ['0', 'all']) {
    const output = run('--month', '2026-10', '--db', costDbPath, '--by', 'session', '--limit', limit);
    assert.match(output, /Fix the build/);
    assert.match(output, /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
    assert.doesNotMatch(output, /Showing/);
  }
  assert.match(run('--help'), /--by model\|session/);
  for (const args of [['--by', 'invalid'], ['--limit=-1'], ['--limit', '-1']]) {
    assert.throws(() => run(...args), (error) => error.status === 1 && /Error: .*--/.test(error.stderr));
  }
  assert.match(run('--month', '2025-01', '--db', costDbPath, '--by', 'session'), /No recorded model calls/);
});
