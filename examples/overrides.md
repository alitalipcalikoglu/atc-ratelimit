# Overrides and blocks

An override replaces a policy's limits for one subject. Use it for partners with a higher quota, for a customer on a smaller plan, and for blocking an abuser.

## Raise a subject

```bash
rcurl -X PUT $RL/v1/policies/api/overrides/key_partner -d '{
  "limits": [ { "window": 60, "limit": 1000 }, { "window": 86400, "limit": 500000 } ],
  "note": "Contract 2026-14, 10x plan"
}'
```

```json
{
  "override": {
    "policy": "api", "subject": "key_partner",
    "limits": [ { "window": 60, "limit": 1000 }, { "window": 86400, "limit": 500000 } ],
    "blocked": false, "note": "Contract 2026-14, 10x plan",
    "expiresAt": null, "expired": false,
    "createdBy": "atc-console", "createdAt": "...", "updatedAt": "..."
  }
}
```

The override's windows replace the policy's windows entirely; usage already recorded for a window length carries over (a 60 s counter stays a 60 s counter). Checks report `"source": "override"`.

## Block a subject

A limit of `0` denies everything:

```bash
rcurl -X PUT $RL/v1/policies/api/overrides/203.0.113.7 -d '{
  "limits": [ { "window": 3600, "limit": 0 } ],
  "note": "Credential stuffing 2026-09-17",
  "expiresAt": "2026-09-18T10:00:00Z"
}'
```

Checks answer `allowed: false, blocked: true, retryAfter: null`; a middleware should send 429 (or 403) without a `Retry-After` header. The window length is irrelevant for a block; any value works.

## Temporary overrides

`expiresAt` (ISO 8601, in the future) makes an override lapse on its own. After that instant checks fall back to the policy; the row stays visible with `"expired": true` until the cleanup worker removes it (within `CLEANUP_INTERVAL_SEC`). Set it on blocks and on trial upgrades; leave it `null` for contracts.

## List, update, remove

```bash
rcurl "$RL/v1/policies/api/overrides?limit=50&offset=0"
rcurl -X PUT $RL/v1/policies/api/overrides/key_partner -d '{ "limits": [ { "window": 60, "limit": 2000 } ] }'   # PUT replaces
rcurl -X DELETE $RL/v1/policies/api/overrides/key_partner                                                       # 204
```

Removing an override returns the subject to the policy's limits with its current usage intact. To also forget the usage, [reset the subject](usage-and-stats.md).
