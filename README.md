# copilot-local-usage

Print a monthly breakdown of GitHub Copilot usage and estimated cost by model or session from your local session database (`~/.copilot/session-store.db`).

```bash
npx github:angelocordon/copilot-local-usage
```

```text
Copilot local usage - 2026-10 (UTC)
Database: /Users/you/.copilot/session-store.db

Model            Recorded calls  Output tokens  AI credits  Est. USD
---------------  --------------  -------------  ----------  --------
gpt-6.1-sol                3,824      1,308,298    9,000.00    $90.00
claude-opus-5.5            1,079        689,516    8,000.00    $80.00
...
---------------  --------------  -------------  ----------  --------
TOTAL                     7,022      2,869,900   19,707.00   $197.07
```

Example values above are illustrative.

## Per-session cost report

```bash
npx github:angelocordon/copilot-local-usage --by session
npx github:angelocordon/copilot-local-usage --by session --month 2026-10 --limit 10
npx github:angelocordon/copilot-local-usage --by session --limit all
npx github:angelocordon/copilot-local-usage --by session --group flat
npx github:angelocordon/copilot-local-usage --by session --order date
npx github:angelocordon/copilot-local-usage --by session --group flat --order date --limit 10
```

Sessions are split into **Monday-Sunday UTC weekly tables**, newest week first,
using the first recorded call in the selected month. Each session appears once.
Sessions within each table are ranked by estimated cost, highest first (the default
`--order cost`). Cost and AI-credit ordering are identical because estimated
USD is AI credits multiplied by $0.01. Use `--order date` to sort by **Date (UTC)**,
newest first. Sorting happens before `--limit` in both weekly and flat tables;
weekly headings remain newest-first. Date ties use cost descending, then
call count descending and session ID ascending. Cost ties use call count
descending and session ID ascending. Missing costs sort after recorded values.
Each row includes a title, short session ID, repository, **Date (UTC)**,
call count, AI credits, estimated USD, and the subagent portion of that estimate.
The title uses the summary's first line
(truncated), falling back to repository/branch or session ID. Calls across all
models in a session are combined; only calls in the selected month count.
The default shows 30 sessions **per weekly table**. Week subtotals include all
sessions in that group even when limited, and **MONTH TOTAL covers every session**.
Use `--group flat` for a single table in the selected order with the same monthly total.

The first-call date is `MIN(assistant_usage_events.created_at)` after filtering
to the selected month, **not necessarily the session's lifetime start**. Session
update dates are not used. Both weekly and flat tables show this same date.

These are first-call groups, **not weekly spending totals**: costs still count
only calls in the selected month, and a session's entire monthly cost goes into
its first-call week. Later calls in other weeks are included in that same row.
A heading such as `Week 2026-10-19 to 2026-10-25` is a grouping range, not a
data cutoff.

### Nested sessions and subagents

Calls attributed to subagents (`assistant_usage_events.agent_id`) under the same
`session_id` are already included in the session's total, across all nesting
levels recorded with that ID. **Subagent USD is a subset of Est. USD**, not an
additional charge. It uses the same recorded-credit calculation; missing
attribution or cost data is shown as `N/A`, with a note for partial records.

Child sessions created with their own session IDs are shown as separate rows.
The current local schema has no parent-session link, so the report cannot
reliably roll them into a parent total or infer nesting from titles or repositories.
They still contribute to the monthly total exactly once.

## Options

| Option | Description |
|---|---|
| `--month YYYY-MM` | Month to report (default: current UTC month) |
| `--db PATH` | Database path (default: `~/.copilot/session-store.db`) |
| `--by model\|session` | Group by model (default) or by session |
| `--group week\|flat` | Session tables by first-call week in the selected month, or one flat table (default: `week` for sessions, `flat` for models). `week` requires `--by session`. |
| `--limit N\|all` | Sessions per table (default: 30; `0` or `all` shows everything). Does not limit model reports or totals. |
| `--order cost\|date` | Session order before limiting: highest estimated cost (default) or newest first-call date. Requires `--by session`. |
| `-h, --help` | Show help |

## Requirements

Node.js 22.13 or newer. No dependencies; uses the built-in `node:sqlite` module.

## Caveats

- Counts are **recorded model calls**, not user prompts. One prompt can trigger several calls.
- AI credits are `SUM(total_nano_aiu) / 1,000,000,000`. Estimated USD uses [1 AI credit = $0.01 USD](https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing), not token-price estimates. Plan discounts and included allowances are not reflected.
- Missing cost data is shown as `N/A`, not zero. Partial totals include only recorded values and display a warning. Older databases without session metadata still group by session ID; databases without usage session IDs cannot produce a session report.
- Only covers sessions retained on this machine. Use [GitHub billing](https://github.com/settings/billing) for authoritative usage and charges.
- The database is opened read-only. Its schema is internal to Copilot and may change.
- Don't share your database file; it contains local session history.

## Development

```bash
npm test
```
