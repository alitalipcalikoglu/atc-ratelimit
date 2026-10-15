# Operations

## Probes

```bash
curl -s $RL/health   # {"status":"ok"}
curl -s $RL/ready    # {"status":"ok"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
rcurl $RL/metrics
```

```
ratelimit_policies 6
ratelimit_decisions_total{policy="api",decision="allowed"} 48210
ratelimit_decisions_total{policy="api",decision="denied"} 1330
ratelimit_counters 3812
ratelimit_db_bytes 2097152
ratelimit_process_uptime_seconds 86400
```

`ratelimit_decisions_total` counts since process start; the hourly [statistics](usage-and-stats.md) persist.

## Environment

Required: `RATELIMIT_API_KEYS`. Full list with defaults: [.env.example](../.env.example).

## Housekeeping

A worker inside the process runs every `CLEANUP_INTERVAL_SEC` (60): it deletes counters older than two of their window lengths, overrides past `expiresAt`, and hourly statistics older than `STATS_RETENTION_DAYS` (30). Nothing to schedule outside.

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload ratelimit
```

One process per database file: SQLite serialises writers, and every check is one short write transaction. A single instance handles thousands of checks per second on ordinary hardware; put a second instance behind a different policy set rather than behind the same file.

## Docker

```bash
docker build -t atc-ratelimit .
docker run -d -p 3011:3011 -v atc-ratelimit-data:/data --env-file .env atc-ratelimit
```

## Backups

```bash
sqlite3 data/ratelimit.db ".backup 'ratelimit-$(date +%F).db'"
```

Policies and overrides are configuration worth backing up; counters are transient (they expire within two windows) and statistics are nice to have. Restoring an old backup restores old counters too; they expire on their own.

## Latency

A check is one round trip plus one SQLite transaction, typically under a millisecond in the service. Put the service on the same network as its callers and keep the client timeout short (300 ms in the [middleware example](middleware.md)); when a limiter is slower than the work it protects, it is the bottleneck.

## High-throughput counters

When a single ratelimit process becomes the bottleneck (every check is one SQLite write), switch to the memory backend:

```
COUNTER_BACKEND=memory
COUNTER_FLUSH_MS=1000
```

Checks are then answered from memory; changed counters and hourly totals are written to SQLite once per `COUNTER_FLUSH_MS`. `GET /v1/info` lists `counters-memory` in `capabilities`.

Watch it in `/metrics`:

```
ratelimit_counter_flushes_total{result="ok"} 8231
ratelimit_counter_flushes_total{result="error"} 0
ratelimit_counter_unflushed 14
```

A rising `error` count means the disk refused the writes; counters stay in memory and are retried on the next flush.

Pitfalls:

- Run exactly one process per database. Two processes with the memory backend each keep their own counts, so a limit of 100 lets 200 through.
- A crash (not a clean stop) loses up to one flush interval of consumption: those clients get that much extra once. `pm2 stop` / `SIGTERM` flushes first.
- Lowering `COUNTER_FLUSH_MS` shrinks that window at the cost of more writes; 100 ms is the minimum.
