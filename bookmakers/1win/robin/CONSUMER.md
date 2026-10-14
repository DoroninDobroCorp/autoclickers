# 1win queue consumer

The supported route from the shared automation queue to a 1win bet, split into two processes with an
explicit contract between them. **Nothing here is enabled by default**: the policy mode defaults to
`disabled`; the executor config must state its mode (`dry` or `real`; `ExecutorCore` itself defaults to `dry`);
and the live gate of the cart (`ONEWIN_AUTOMATION_LIVE_ENABLED`) is a third, separate switch.

```
 producers (analyzer, telegram)            consumer (Python, next to the queue)                 executor (Node, where the account lives)
 core/node TaskBuilder + TasksManager ──►  python -m onewin_automation.consumer  ──HTTP──►  scripts/onewin/executor_service.mjs
 tasks.json, one slot per bookmaker          queue_worker.mjs  (TasksManager I/O)             ExecutorCore → OneWinLiveCart
                                             common engine: adapter, readiness,              transport guard v2 (+ OOPIF admission)
                                             Jev (advice), order, cart plan, export          DurableAttemptStore (the money journal)
```

## Entrypoints

| What | Command | Where |
|---|---|---|
| consumer | `python -m onewin_automation.consumer run --policy <policy.json> [--mode observe\|dry\|real] [--max-items N] [--idle-exit-s S]` | cwd `bookmakers/1win/robin`, Python ≥ 3.11, stdlib only; needs `node` for the queue worker |
| consumer status / reconcile | `… status --policy P` · `… reconcile --policy P --key K (--bet-id ID \| --not-placed) --evidence TEXT --operator NAME` | same |
| executor | `node scripts/onewin/executor_service.mjs --config <executor.json>` | the machine that owns the account session; Node ≥ 20, Playwright |
| queue worker | `node scripts/onewin/queue_worker.mjs --tasks-file F [--bookmaker 1win]` | started by the consumer; never by hand in production |

`--mode` on the command line can only **lower** the mode of the policy file. A policy without `mode` is `disabled`.

## Policy (consumer) — `onewin-consumer-policy.v1`, private file, no default path

The policy owns what a queue item may not decide: `account_id`, `currency` (only `USDT`), `stake`, `max_stake`
(a diagnostic test stakes exactly 1 and never above 1), `environment` (`production` | `local_stand`, stated
explicitly), the queue file and the state directory. Unknown fields are refused. Secrets are only *names of
environment variables* (`executor.token_env`, `jev.url_env`, `jev.token_env`).

| mode | reads queue | claims / writes queue | calls executor | sends money |
|---|---|---|---|---|
| `disabled` (default) | no | no | no | no |
| `observe` | yes | no | read-only evidence only (and, when Jev is configured, one advice call) | no |
| `dry` | yes | claim + `dry_run` history record | evidence + read-only cart | no |
| `real` | yes | claim + outcome record | evidence + order | only if the executor itself is `real` **and** its live gate is open |

`real` refuses to start unless the executor reports `mode=real`, `live_gate_open=true` and the same
`transport_environment` as the policy.

### Example policy (every value is an operator's; paths and URLs are placeholders)

```json
{
  "schema": "onewin-consumer-policy.v1",
  "mode": "observe",
  "account_id": "acct-1",
  "currency": "USDT",
  "stake": 1.0,
  "max_stake": 1.0,
  "purpose": "diagnostic_test",
  "environment": "production",
  "bookmaker_id": "1win",
  "tasks_file": "<path of the queue file>",
  "state_dir": "<directory for journal, prepared store and exports>",
  "executor": {"url": "http://127.0.0.1:<tunnel port>", "token_env": "ONEWIN_EXECUTOR_TOKEN"},
  "jev": {"url_env": "ONEWIN_JEV_URL", "token_env": "ONEWIN_JEV_TOKEN", "timeout_s": 2.5}
}
```

### Example executor config (`executor_service.mjs --config`)

```json
{
  "store_path": "<durable attempt store of this account>",
  "mode": "dry",
  "environment": "production",
  "token_env": "ONEWIN_EXECUTOR_TOKEN",
  "listen": {"host": "127.0.0.1", "port": 0},
  "session": {"proxy_config_path": "<private proxy config>", "expected_proxy_endpoint": "<approved host:port>",
              "storage_state_path": "<stored session of the account>", "executable_path": "<full Chrome, not the headless shell>"}
}
```

`environment: production` takes the production bet origins; `local_stand` needs `bet_api_origins` (and `site_origin`)
and exists for isolated drills only. `listen.host` must be loopback.

## Executor contract — `automation-executor.v1`

JSON over HTTP, bearer token on every call (token taken from the environment variable named in the config),
loopback listener (a consumer on another host reaches it through a tunnel).

| call | meaning |
|---|---|
| `GET /v1/health` | contract, mode, `transport_environment` (derived from the configured origins, never from an order), guard version, live gate, store durability, orphans resolved at start |
| `POST /v1/evidence` | read-only: executor quote + account state + UI strings for a task identity; `available:false` + reason when no provider is configured |
| `POST /v1/orders` | `automation-executor-order.v1` (plan, provenance, consumer id). Returns at once (`202`); a key that is already known is **not** executed again |
| `POST /v1/dry-runs` | the same plan through the read-only cart; nothing can be placed |
| `GET /v1/attempts/<key>` | durable attempt + `in_flight` + `last_run` |
| `POST /v1/attempts/<key>/withdraw` | request a withdrawal (read at the point of no return); before the claim it leaves a tombstone |
| `POST /v1/attempts/<key>/revisions` | `receipt_reconciled` / `reconciled_not_placed` for an `INDETERMINATE` attempt only |
| `POST /v1/recover` | settle attempts whose owner is gone; never re-sends |

The executor stamps `executor_provenance` (environment, origins, guard version) and the order's
`provenance.synthetic` into the durable attempt. The exporter reads provenance **from the attempt**, not from the caller.

## State machine of one queue item

Consumer journal (`<state_dir>/<account_id>/journal.jsonl`, fsync per record):
`claimed → built → handed_off → observed → decided → queue_written → exported`.

Executor attempt (`attempts.json`): `CLAIMED → PRE_CHECK_PASSED → SUBMITTING → ACCEPTED | REJECTED | INDETERMINATE`,
or `WITHDRAWN` (with proof when it was SUBMITTING). Queue history record (`recordExecutionOutcome`, idempotent per attempt key):

| attempt | queue history | exposure | blocks the match |
|---|---|---|---|
| `ACCEPTED` (receipt id of this attempt) | `completed` + `ticketId` | yes | no |
| `REJECTED` (proved refusal) | `failed`, `bookmakerRejected` | no | counts as a failure |
| `WITHDRAWN` / refused before the order | `cancelled` | no | no |
| `INDETERMINATE` / unknown | **`unresolved`** (never `failed`, never aged out) | yes (until reconciled) | no |
| dry run | `dry_run` | no | no |

An unresolved outcome is never re-sent: the attempt key is durable, one live intent per native selection is
enforced by the attempt store, and the native `idempotencyKey` the first-party page put on the wire is stored in
the attempt **before** the request is allowed to leave. Resolution is by identity (`reconcile`).

## Restart

| point | what survives | what the restart does |
|---|---|---|
| consumer dies before the hand-off | journal `claimed/built(/handed_off)` | asks the executor: never heard → `not_sent`; the slot is freed |
| executor dies after the claim, before SUBMITTING | `CLAIMED/PRE_CHECK_PASSED` | executor start: `WITHDRAWN`; consumer: late resolution → `cancelled(reconciled)` |
| executor dies after SUBMITTING / request received | `SUBMITTING`, native key | executor start: `INDETERMINATE`; stays `unresolved`; operator reconciles |
| consumer dies after the answer, before the queue write | journal `observed/decided` | writes the queue (idempotent), exports |
| consumer dies after the queue write, before the export | journal `queue_written` | exports |
| the same queue message again | journal `exported` | frees the slot, sends nothing |

## What is NOT here

* No production evidence provider: `evidence.available=false` until an operator wires one (the research probe
  `scripts/onewin/account_readonly_probe.mjs` is the reference). Commission and market maximum are not invented.
* Network-stack retry of a POST and browser-process GET prefetch cannot be decided by the transport guard
  (see HANDOFF, `transport_residuals_probe.mjs`).
* Settlement, ROI, ledger: out of scope; the export says `settlement: pending`, `financial_result: not_recorded`.
