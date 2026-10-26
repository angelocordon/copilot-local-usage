#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { currentMonth, formatReport, monthBounds, readUsage } from '../src/usage.js';

const HELP = `Usage: copilot-local-usage [--month YYYY-MM] [--db PATH]

Print monthly usage from the Copilot app's local session database.

Options:
  --month YYYY-MM  Month to report (default: current UTC month)
  --db PATH        Local session database (default: ~/.copilot/session-store.db)
  -h, --help       Show this help

Reports locally retained model calls, not user prompts, billed credits,
or account-wide usage. The database is opened read-only.`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

// node:sqlite emits an ExperimentalWarning on load; hide only that one.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite/i.test(text ?? '')) return;
  return emitWarning.call(process, warning, ...args);
};

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  fail(`Node.js 22.13 or newer is required (found ${process.version}).`);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      month: { type: 'string' },
      db: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (error) {
  fail(`${error.message}\n\n${HELP}`);
}

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const month = values.month ?? currentMonth();
const dbPath = resolve(
  (values.db ?? join(homedir(), '.copilot', 'session-store.db')).replace(/^~(?=$|\/)/, homedir()),
);

try {
  const rows = readUsage(DatabaseSync, dbPath, monthBounds(month));
  console.log(formatReport(rows, month, dbPath));
} catch (error) {
  fail(error.message);
}
