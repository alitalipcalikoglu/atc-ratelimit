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
