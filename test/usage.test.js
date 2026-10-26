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
    ALTER TABLE sessions ADD COLUMN updated_at TEXT;
    UPDATE sessions SET updated_at = '2026-10-18T23:59:59Z' WHERE id = 'expensive';
    UPDATE sessions SET updated_at = 'invalid date' WHERE id = 'empty';
    INSERT INTO sessions (id, updated_at) VALUES ('orphan', '2026-10-19 00:00:00');
    ALTER TABLE assistant_usage_events ADD COLUMN agent_id TEXT;
    UPDATE assistant_usage_events SET agent_id = 'nested-agent'
      WHERE rowid IN (2, 7);
    UPDATE assistant_usage_events SET agent_id = 'another-agent' WHERE rowid = 3;
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
  assert.deepEqual(reportOptions(), { by: 'model', limit: 30, group: 'flat' });
  assert.deepEqual(reportOptions({ by: 'session' }), { by: 'session', limit: 30, group: 'week', order: 'cost' });
  for (const limit of ['0', 'all']) {
    assert.deepEqual(reportOptions({ by: 'session', limit }), { by: 'session', limit: 0, group: 'week', order: 'cost' });
  }
  for (const limit of ['-1', '1.5', 'NaN', '', '9007199254740992']) {
    assert.throws(() => reportOptions({ limit }), /--limit/);
  }
  assert.throws(() => reportOptions({ by: 'invalid' }), /--by/);
  assert.throws(() => reportOptions({ by: 'session', group: 'day' }), /--group/);
  assert.throws(() => reportOptions({ group: 'week' }), /requires --by session/);
  assert.equal(reportOptions({ by: 'session', order: 'date' }).order, 'date');
  assert.equal(reportOptions({ by: 'session', order: 'cost' }).order, 'cost');
  for (const options of [{ order: 'cost' }, { order: 'date' }, { by: 'session', order: 'credits' }, { by: 'session', order: 'invalid' }]) {
    assert.throws(() => reportOptions(options), /--order/);
  }
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
  const output = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 1, group: 'flat' });
  assert.match(output, /Fix the build/);
  assert.match(output, /Date \(UTC\)/);
  assert.match(output, /2026-10-01/);
  assert.doesNotMatch(output, /Updated\/start|2026-10-18/);
  assert.match(output, /first recorded call in the selected month, not necessarily the session start/);
  assert.doesNotMatch(output, /Ignore this second line/);
  assert.match(output, /2,500\.00\s+\$25\.00/);
  assert.match(output, /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
  assert.match(output, /Showing 1 of 5 sessions; TOTAL includes all sessions/);
  assert.match(output, /3 calls have no cost data/);
  const all = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 'all', group: 'flat' });
  assert.match(all, /owner\/free \/ main/);
  assert.match(all, /\(unknown session\)/);
  assert.doesNotMatch(all, /Showing/);
  const many = Array.from({ length: 31 }, (_, i) => ({ ...rows[0], sessionId: `session-${i}` }));
  const limited = formatReport(many, '2026-10', costDbPath, { by: 'session', group: 'flat' });
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

test('session ordering precedes limits in flat and weekly reports without changing totals', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'), { by: 'session' });
  const original = [...rows];
  const sessionLines = (output) => output.split('\n').filter((line) =>
    /^(?:Fix the build|orphan|owner\/free|empty|\(unknown session\))\s/.test(line));
  const render = (group, order, limit = 'all') =>
    formatReport(rows, '2026-10', costDbPath, { by: 'session', group, order, limit });
  const costs = render('flat', 'cost');
  const dates = render('flat', 'date');
  assert.equal(costs, formatReport(rows, '2026-10', costDbPath, { by: 'session', group: 'flat', limit: 'all' }));
  assert.match(sessionLines(costs)[0], /^Fix the build/);
  assert.deepEqual(sessionLines(dates).map((line) => line.match(/\d{4}-\d{2}-\d{2}/)[0]),
    ['2026-10-10', '2026-10-09', '2026-10-08', '2026-10-07', '2026-10-01']);
  assert.match(sessionLines(render('flat', 'date', 1))[0], /^\(unknown session\)/);
  assert.match(sessionLines(render('flat', 'cost', 1))[0], /^Fix the build/);
  for (const order of ['cost', 'date']) {
    assert.match(render('flat', order, 1), /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
    const weekly = render('week', order, 1);
    assert.deepEqual([...weekly.matchAll(/^Week .+$/gm)].map((m) => m[0]), [
      'Week 2026-10-05 to 2026-10-11', 'Week 2026-09-28 to 2026-10-04',
    ]);
    assert.match(weekly, /MONTH TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
  }
  assert.match(sessionLines(render('week', 'date', 1))[0], /^\(unknown session\)/);
  assert.match(sessionLines(render('week', 'cost', 1))[0], /^orphan/);
  assert.deepEqual(rows, original);
});

test('session order ties use recorded credits, calls, and IDs deterministically, not time of day', () => {
  const base = { calls: 1, outputTokens: 0, callsWithOutputTokens: 1, callsWithCost: 1 };
  const rows = [
    { ...base, sessionId: 'null-cost', start: '2026-10-08', credits: null },
    { ...base, sessionId: 'z-id', start: '2026-10-08T23:00:00Z', credits: 0 },
    { ...base, sessionId: 'a-id', start: '2026-10-08 01:00:00', credits: 0 },
    { ...base, sessionId: 'more-calls', start: '2026-10-08', credits: 0, calls: 2 },
    { ...base, sessionId: 'older-cost', start: '2026-10-01', credits: 1 },
  ];
  const ids = (order) => {
    const output = formatReport(rows, '2026-10', 'test.db', { by: 'session', group: 'flat', order });
    return output.split('\n').filter((line) => rows.some((row) => line.startsWith(`${row.sessionId} `)))
      .map((line) => line.trim().split(/\s+/)[0]);
  };
  assert.deepEqual(ids('date'), ['more-calls', 'a-id', 'z-id', 'null-cost', 'older-cost']);
  assert.deepEqual(ids('cost'), ['older-cost', 'more-calls', 'a-id', 'z-id', 'null-cost']);
  const reversed = formatReport([...rows].reverse(), '2026-10', 'test.db', { by: 'session', group: 'flat', order: 'date' });
  assert.equal(reversed, formatReport(rows, '2026-10', 'test.db', { by: 'session', group: 'flat', order: 'date' }));
});

test('subagent costs are a subset of session totals, not additional charges', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'), { by: 'session' });
  assert.equal(rows[0].subagentCalls, 2);
  assert.equal(rows[0].subagentCredits, 500);
  assert.equal(rows[0].credits, 2500);
  assert.equal(rows[1].subagentCredits, 1);
  assert.equal(rows[2].subagentCredits, 0);
  const output = formatReport(rows, '2026-10', costDbPath, { by: 'session', group: 'flat' });
  assert.match(output, /TOTAL\s+7\s+2,501\.00\s+\$25\.01\s+\$5\.01/);
  assert.match(output, /3 identified subagent calls/);
  assert.match(output, /included in Est\. USD, not added again/);
  assert.match(output, /Separate child sessions remain separate/);
});

test('weekly tables use first monthly calls, ignore updates, and preserve cost ordering and totals', () => {
  const rows = readUsage(DatabaseSync, costDbPath, monthBounds('2026-10'), { by: 'session' });
  assert.equal(rows[0].start, '2026-10-01 01:00:00');
  const output = formatReport(rows, '2026-10', costDbPath, { by: 'session', limit: 1 });
  const headings = [...output.matchAll(/^Week .+$/gm)].map((match) => match[0]);
  assert.deepEqual(headings, [
    'Week 2026-10-05 to 2026-10-11',
    'Week 2026-09-28 to 2026-10-04',
  ]);
  assert.match(output, /WEEK TOTAL\s+3\s+2,500\.00\s+\$25\.00\s+\$5\.00/);
  assert.match(output, /Showing 1 of 4 sessions; WEEK TOTAL includes all sessions in this group/);
  assert.match(output, /orphan\s+orphan\s+N\/A\s+2026-10-07/);
  assert.match(output, /Fix the build\s+expensive\s+owner\/repo\s+2026-10-01/);
  assert.match(output, /MONTH TOTAL\s+7\s+2,501\.00\s+\$25\.01\s+\$5\.01/);
  assert.match(output, /Costs are for the selected month, not spend within each week/);
});

test('weekly grouping handles year boundaries and ignores updates outside the report month', () => {
  const path = join(dir, 'weekly-dates.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at TEXT);
    CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, created_at TEXT, output_tokens INTEGER);
    INSERT INTO sessions VALUES ('offset', '2027-01-04T00:30:00+02:00'), ('future', '2027-02-01');
    INSERT INTO assistant_usage_events VALUES
      ('offset', 'model', '2026-12-01', 1),
      ('future', 'model', '2026-12-02', 1),
      ('offset', 'model', '2026-11-30', 99),
      ('offset', 'model', '2027-01-01', 99),
      ('missing', 'model', '2026-12-31', 1);`);
  db.close();
  const rows = readUsage(DatabaseSync, path, monthBounds('2026-12'), { by: 'session' });
  assert.equal(rows.find((r) => r.sessionId === 'offset').start, '2026-12-01');
  const output = formatReport(rows, '2026-12', path, { by: 'session' });
  assert.match(output, /Week 2026-12-28 to 2027-01-03/);
  assert.match(output, /Week 2026-11-30 to 2026-12-06/);
  assert.doesNotMatch(output, /Week 2027-02-01/);
  assert.match(output, /offset\s+offset\s+N\/A\s+2026-12-01/);
  assert.match(output, /future\s+future\s+N\/A\s+2026-12-02/);
  assert.match(output, /MONTH TOTAL\s+3\s+N\/A\s+N\/A/);
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
  assert.equal(rows[0].subagentCalls, null);
  const output = formatReport(rows, '2026-10', path, { by: 'session' });
  assert.match(output, /legacy-id\s+legacy-id\s+N\/A/);
  assert.match(output, /Week 2026-09-28 to 2026-10-04/);
  assert.match(output, /Subagent attribution is unavailable/);
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
    const output = run('--month', '2026-10', '--db', costDbPath, '--by', 'session', '--limit', limit, '--group', 'flat');
    assert.match(output, /Fix the build/);
    assert.match(output, /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
    assert.doesNotMatch(output, /Showing/);
  }
  assert.match(run('--help'), /--by model\|session/);
  const weekly = run('--month', '2026-10', '--db', costDbPath, '--by', 'session', '--limit', '1');
  assert.match(weekly, /Week 2026-09-28 to 2026-10-04/);
  assert.match(weekly, /Date \(UTC\)/);
  assert.doesNotMatch(weekly, /Updated\/start|last updated/);
  assert.match(weekly, /MONTH TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
  assert.match(run('--help'), /--order cost\|date/);
  const costOrdered = run('--month', '2026-10', '--db', costDbPath, '--by', 'session',
    '--group', 'flat', '--order', 'cost', '--limit', '1');
  assert.match(costOrdered, /Fix the build/);
  assert.match(costOrdered, /AI credits/);
  assert.doesNotMatch(costOrdered, /\(unknown session\)/);
  for (const group of ['week', 'flat']) {
    const dated = run('--month', '2026-10', '--db', costDbPath, '--by', 'session', '--group', group, '--order', 'date', '--limit', '1');
    assert.match(dated, /\(unknown session\)\s+N\/A\s+N\/A\s+2026-10-10/);
    assert.doesNotMatch(dated, /First call \(UTC\)/);
    assert.match(dated, /TOTAL\s+7\s+2,501\.00\s+\$25\.01/);
  }
  for (const args of [['--by', 'invalid'], ['--limit=-1'], ['--limit', '-1'], ['--group', 'week'], ['--group', 'invalid'],
    ['--order', 'date'], ['--by', 'model', '--order', 'cost'], ['--by', 'session', '--order', 'credits'], ['--by', 'session', '--order', 'invalid']]) {
    assert.throws(() => run(...args), (error) => error.status === 1 && /Error: .*--/.test(error.stderr));
  }
  assert.match(run('--month', '2025-01', '--db', costDbPath, '--by', 'session'), /No recorded model calls/);
});
