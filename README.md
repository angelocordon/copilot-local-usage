# copilot-local-usage

Print a monthly breakdown of GitHub Copilot model usage from your local session database (`~/.copilot/session-store.db`).

```bash
npx github:angelocordon/copilot-local-usage
```

```text
Copilot local usage - 2026-10 (UTC)
Database: /Users/you/.copilot/session-store.db

Model              Recorded calls  Output tokens
-----------------  --------------  -------------
gpt-6.1-sol                 3,824      1,308,298
claude-opus-5.5             1,079        689,516
...
-----------------  --------------  -------------
TOTAL                       7,022      2,869,900
```

## Options

| Option | Description |
|---|---|
| `--month YYYY-MM` | Month to report (default: current UTC month) |
| `--db PATH` | Database path (default: `~/.copilot/session-store.db`) |
| `-h, --help` | Show help |

## Requirements

Node.js 22.13 or newer. No dependencies; uses the built-in `node:sqlite` module.

## Caveats

- Counts are **recorded model calls**, not user prompts or billed credits. One prompt can trigger several calls.
- Only covers sessions retained on this machine. Use [GitHub billing](https://github.com/settings/billing) for authoritative usage and charges.
- The database is opened read-only. Its schema is internal to Copilot and may change.
- Don't share your database file; it contains local session history.

## Development

```bash
npm test
```
