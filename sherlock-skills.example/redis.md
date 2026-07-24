---
description: Diagnose the Redis server on a host — connectivity, memory, slow queries.
allow:
  - redis-cli PING
  - redis-cli INFO
  - redis-cli --latency-history
  - redis-cli SLOWLOG GET
  - redis-cli DBSIZE
---

Redis runs on hosts that carry this skill. Use `redis-cli` for all diagnostics.

## Health checks

- `redis-cli PING` — expect `PONG`. Anything else (or a connection error) means Redis is down or unreachable.
- `redis-cli INFO memory` — check `used_memory_human` against `maxmemory_human`; `evicted_keys` growing means memory pressure.
- `redis-cli INFO stats` — `rejected_connections`, `keyspace_misses` vs `keyspace_hits`.
- `redis-cli SLOWLOG GET 20` — recent slow commands with microsecond timings.

## Diagnosing latency complaints

1. `redis-cli PING` to confirm reachability.
2. `redis-cli INFO memory` — evictions and fragmentation (`mem_fragmentation_ratio` > 1.5 is suspect).
3. `redis-cli SLOWLOG GET 20` — look for O(N) commands (KEYS, SMEMBERS on huge sets).
4. Cite the slow commands and timings in your answer.

## Mutations (approval required)

- `redis-cli CONFIG SET <param> <value>` — runtime config change.
- `redis-cli FLUSHDB` / `FLUSHALL` — destructive; never propose unless the user explicitly asked to flush.
- `sudo systemctl restart redis-server` — full restart; drops all connections.
