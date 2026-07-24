---
description: Investigate and manage PM2-supervised processes — status, restarts, logs, lifecycle.
allow:
  - pm2 jlist
  - pm2 list
  - pm2 status
  - pm2 info
  - pm2 describe
  - pm2 logs
  - pm2 env
  - pm2 report
  - pm2 prettylist
---

PM2 is a process manager for Node.js apps. Hosts running this skill supervise their services with PM2.

## Inspecting processes

Prefer `pm2 jlist` — it prints a JSON array, far easier to read reliably than the `pm2 list` table. Key fields per process:

- `name`, `pm_id`, `pid`
- `pm2_env.status` — `online`, `stopped`, `errored`, `launching`
- `pm2_env.restart_time` — total restart count (high number = crash-looping)
- `pm2_env.unstable_restarts` — restarts within the uptime threshold; nonzero means real instability
- `pm2_env.pm_uptime` — start time in epoch ms (recent value on a long-lived process means it just restarted)
- `pm2_env.exit_code` — last exit code
- `pm2_env.pm_out_log_path` / `pm2_env.pm_err_log_path` — log file locations
- `pm2_env.exec_mode`, `pm2_env.instances`, `pm2_env.pm_cwd`, `pm2_env.pm_exec_path`
- `monit.cpu` (percent), `monit.memory` (bytes)

`pm2 describe <name|id>` gives a human-readable summary of one process (log paths, env, restart history).

## Reading logs

```
pm2 logs <name|id> --lines <N> --nostream --raw
```

- ALWAYS pass `--nostream` — without it pm2 tails forever and the command times out with no useful output.
- Add `--err` for stderr only (crash stacks live here) or `--out` for stdout only.
- Up to a few hundred lines is reasonable; start with 200.

## Diagnosing "why is X restarting / down"

1. `pm2 jlist` — check `status`, `restart_time`, `unstable_restarts`, and how recent `pm_uptime` is.
2. `pm2 logs <name> --lines 200 --nostream --raw --err` — find the actual error or stack trace.
3. If logs are rotated or empty, read the paths from `pm_err_log_path` directly.
4. Report the finding with evidence: process name, restart count, the error message, timestamps.

## Changing process state (approval required)

These mutate the host and will trigger a human Approve/Deny prompt — state your rationale in the message right before running them:

- `pm2 restart <name|id|all>` — hard restart
- `pm2 reload <name>` — zero-downtime reload (cluster mode only)
- `pm2 stop <name>` / `pm2 start <name>`
- `pm2 delete <name>` — removes the process from PM2 entirely; destructive, avoid unless explicitly asked

Never restart a process just to "see if it helps" — diagnose first, and prefer `reload` over `restart` for cluster-mode processes serving traffic.
