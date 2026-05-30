# Security & Reliability Fixes — Top 5

This branch applies the top-5 fixes from the code review:

1. **H1** — Validate X-Forwarded-For trust on HTTP + WS paths
2. **H11** — DB-level unique constraint backing per-IP vote dedup
3. **H16** — Wrap voting flush in a transaction; idempotent inserts
4. **H23** — Hard timeout on flushPending() during SIGTERM
5. **M4 + M5** — Security headers + /metrics fail-closed default

See PR description for full details.
