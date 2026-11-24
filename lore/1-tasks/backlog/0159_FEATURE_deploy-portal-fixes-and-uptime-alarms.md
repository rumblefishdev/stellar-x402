---
id: "0159"
title: "Deploy the portal's late fixes and turn on the portal and hub uptime alarms"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0011"]
related_tasks: ["0106", "0027"]
tags: [portal, deploy, monitoring, before-pubnet, platform, priority-medium, effort-small]
links:
  - ../archive/0106_FEATURE_api-key-portal-discord.md
history:
  - date: "2026-11-23"
    status: backlog
    who: akot
    note: "Spawned from 0106 future work."
---

# Deploy the portal's late fixes and turn on the portal and hub uptime alarms

## Summary

0106 closed with three merged changes not yet on production: the sealed store's revoke fix and the
30-day log rotation (#223), and the uptime probes for the portal's backend and the API hub's
(#222). Deploy them, then turn the two alarm groups on.

## Context

- #223's store fix ships in the portal's image; its log rotation is a file the playbook installs
  (`deploy/logrotate/x402-logs.conf`). The rotation must be on the server before pubnet opens: the
  facilitator then logs `caller: discord:<id>`, and the hub's privacy policy keeps log lines up to
  30 days.
- #222's probes are two more functions in the Uptime stack. Their alarm groups, `portalUptime` and
  `hubUptime`, are off in `infra/envs/production.json`: with a missing point counted as down, an
  alarm made before its probe publishes pages at once.
- On 2026-11-23 both URLs answered what the probes expect, and AWS Chatbot answered Slack
  `account_inactive`: no alarm reaches Slack until a Slack admin authorizes the AWS app again.

## Implementation

- Promote `develop` to `deploy/production`; the portal's deploy needs `production-portal`'s
  approval by someone other than the author.
- Run the playbook from `deploy/production` (`--check --diff` first) for the rotation, and check a
  quiet file rotates the next day.
- `cdk deploy` the Uptime and Alarms stacks; once `portal_ready` and `hub_ready` have published 1
  for a while, set both groups to `true` and deploy Alarms again.
- Have the AWS app authorized in Slack again, then send a test alarm.

## Acceptance Criteria

- [ ] Given production, when the portal's backend runs the image with #223, then `/health` is
      ready and a `reveal` after a revoke-then-issue still shows the key
- [ ] Given the server, when a day has passed, then every log file has rotated and none is older
      than 30 days
- [ ] Given the two probes, when either backend stops answering as expected for 7 minutes, then
      its alarm fires and the message reaches Slack
