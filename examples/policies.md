# Policies

A policy is a named set of windows. Every window says "at most `limit` units per `window` seconds"; a check passes only when every window has room.

## Create

```bash
rcurl -X POST $RL/v1/policies -d '{
  "name": "api",
  "description": "Public API, per API key",
  "limits": [
    { "window": 60, "limit": 100 },
    { "window": 86400, "limit": 20000 }
  ]
}'
```

```json
{
  "policy": {
    "name": "api",
    "description": "Public API, per API key",
    "limits": [ { "window": 60, "limit": 100 }, { "window": 86400, "limit": 20000 } ],
    "overrides": 0,
    "activeSubjects": 0,
    "last24h": { "allowed": 0, "denied": 0 },
    "createdBy": "atc-console",
    "createdAt": "2026-09-17T10:00:00.000Z",
    "updatedAt": "2026-09-17T10:00:00.000Z"
  }
}
```

Names are lowercase `a-z0-9` with `.`, `-` or `_` between parts (`api`, `login.password`, `export-jobs`). Windows are sorted by length on save; at most `MAX_LIMITS` (5) per policy, the longest window is `MAX_WINDOW_SEC` (30 days). A `limit` of `0` denies everything, which is useful only in an [override](overrides.md).

## Typical policies

| Policy | Limits | Subject |
|---|---|---|
| `api` | 100/60 s, 20 000/day | API key id |
| `login` | 5/60 s, 20/hour | email or IP |
| `signup` | 3/hour | IP |
| `sms` | 3/10 min, 10/day | phone number |
| `export` | 2/hour | user id |
| `search` | 30/10 s | session id |

The subject is any string your caller chooses (up to 200 characters, no control characters). The service never inspects it; hash personal data (emails, phone numbers) before sending it if the database must not hold it.

## List and read

```bash
rcurl $RL/v1/policies
rcurl $RL/v1/policies/api
```

Every policy reports `overrides`, `activeSubjects` (subjects with a counter in a live window) and `last24h` decisions.

## Change limits

```bash
rcurl -X PATCH $RL/v1/policies/api -d '{ "limits": [ { "window": 60, "limit": 200 }, { "window": 86400, "limit": 20000 } ] }'
```

Counters are keyed by window length, so raising or lowering a limit takes effect on the next check without losing usage. Removing a window drops its counters at the next cleanup; adding a window starts it empty.

## Delete

```bash
rcurl -X DELETE $RL/v1/policies/api     # 204
```

Deletes the policy with its overrides, counters and statistics. Checks against it return `404 POLICY_NOT_FOUND` afterwards; a middleware that fails open (see [middleware](middleware.md)) then lets traffic through, so delete a policy only after its callers stop using it.
