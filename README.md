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
```

Sessions are split into **Monday-Sunday UTC weekly tables**, newest week first,
using `sessions.updated_at` (falling back to the first recorded call in the selected
month when the update is missing or invalid). Each session appears once.
Sessions within each table are ranked by estimated cost, highest first.
Each row includes a title, short session ID, repository, update/fallback date (UTC),
call count, AI credits, estimated USD, and the subagent portion of that estimate.
The title uses the summary's first line
(truncated), falling back to repository/branch or session ID. Calls across all
models in a session are combined; only calls in the selected month count.
The default shows 30 sessions **per weekly table**. Week subtotals include all
sessions in that group even when limited, and **MONTH TOTAL covers every session**.
Use `--group flat` for a single cost-ranked table with the same monthly total.

These are activity-date groups, **not weekly spending totals**: costs still count
only calls in the selected month, and a session's entire monthly cost goes into
its update-date group. Later activity can move a session into a different week,
even outside the selected month; the local database retains only its latest update.

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
| `--group week\|flat` | Session table layout (default: `week` for sessions, `flat` for models). `week` requires `--by session`. |
| `--limit N\|all` | Sessions per table (default: 30; `0` or `all` shows everything). Does not limit model reports or totals. |
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
