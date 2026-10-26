#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { currentMonth, formatReport, monthBounds, readUsage, reportOptions } from '../src/usage.js';

const HELP = `Usage: copilot-local-usage [--month YYYY-MM] [--db PATH] [--by model|session] [--limit N|all]

Print monthly usage from the Copilot app's local session database.

Options:
  --month YYYY-MM  Month to report (default: current UTC month)
  --db PATH        Local session database (default: ~/.copilot/session-store.db)
  --by model|session  Group by model (default) or session, ranked by estimated cost
  --limit N|all    Sessions to show (default: 30; 0 or all shows every session)
  -h, --help       Show this help

Reports locally retained model calls and estimated cost, not user prompts
or account-wide charges. GitHub billing is authoritative. Opened read-only.`;

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
      by: { type: 'string' },
      limit: { type: 'string' },
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
  const options = reportOptions(values);
  const rows = readUsage(DatabaseSync, dbPath, monthBounds(month), options);
  console.log(formatReport(rows, month, dbPath, options));
} catch (error) {
  fail(error.message);
}
