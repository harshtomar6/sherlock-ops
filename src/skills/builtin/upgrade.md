---
description: Check Sherlock's installed version and upgrade the control plane or agents on request.
allow:
  - cat /opt/sherlock-ops/BUILD_INFO
  - cat /opt/sherlock-agent/BUILD_INFO
  - git ls-remote
  - systemctl status sherlock-ops
  - systemctl status sherlock-agent
---

You can inspect and upgrade the Sherlock installation itself. The control plane lives in `/opt/sherlock-ops`; on agent hosts the install is `/opt/sherlock-agent`. (Operators who installed elsewhere override this skill with corrected paths.)

## Checking the installed version

`cat /opt/sherlock-ops/BUILD_INFO` (or the agent path on agent hosts) — written at install time:

```
commit=<short sha>
ref=<branch or tag>
repo=<git url>
installed_at=<UTC timestamp>
```

## Checking whether an update is available

Compare the installed commit against the remote using the `repo` and `ref` values from BUILD_INFO:

```
git ls-remote <repo> <ref>
```

If the returned full sha starts with the BUILD_INFO `commit`, the install is up to date. Do NOT use `git log`/`git status` inside the install dir — it is root-owned and git will refuse.

## Upgrading (approval required)

```
sudo /opt/sherlock-ops/deploy/upgrade.sh      # control plane
sudo /opt/sherlock-agent/deploy/upgrade.sh    # an agent, targeted at that host
```

Always check for an update first and tell the user what they're upgrading from → to before proposing this. What happens after approval:

- The script detaches the real work into a background systemd unit, then returns immediately — report its output to the user.
- The background job pulls the latest code, rebuilds, and restarts the service. Takes roughly 1–3 minutes.
- A control-plane upgrade restarts *this bot*: it will go quiet for a few seconds mid-upgrade. Conversation history survives the restart, so the thread continues afterwards. Warn the user about the brief gap before proposing the upgrade.
- Config (`.env`, `hosts.json`, `sherlock-config.json`, custom skills, audit log) is preserved; only code updates.

Verify afterwards (or when the user asks "did it work") by re-reading BUILD_INFO — `installed_at` and `commit` should have changed — and `systemctl status sherlock-ops` should show the service active with a recent start time.

If `sudo` fails with "not allowed" or asks for a password, self-upgrade wasn't enabled at install time. Tell the operator to re-run the installer and opt into self-upgrade (or run `sudo bash <install dir>/deploy/upgrade.sh` themselves), and do not retry.

In multi-host mode, upgrade each agent separately by targeting its host. Upgrade agents before the control plane when doing both, so a protocol version bump doesn't strand old agents.
