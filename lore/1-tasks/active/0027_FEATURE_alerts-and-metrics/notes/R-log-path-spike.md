---
title: "How log lines reach the CloudWatch agent: spike"
type: research
status: mature
tags: [monitoring, cloudwatch, emf, spike]
links:
  - ../README.md
  - ../../../../../docs/adr/0011-facilitator-hosting.md
history:
  - date: "2026-11-02"
    status: mature
    who: akot
    note: "Local spike for decision 1: unit file, real agent, a stub for CloudWatch. Nothing created in AWS."
  - date: "2026-11-03"
    status: mature
    who: akot
    note: "Second run from Oskar's review of #111: stderr in its own file, rotation with both agent entries, an outage across a rotation, and the agent joining whitespace lines."
---

# How log lines reach the CloudWatch agent: spike

The question: ADR 0011 has the agent read Docker's `json-file` logs, and asks 0027 to check that
EMF lines become metrics on that path. A `json-file` line wraps ours in `{"log":"...","stream":...}`,
so `_aws` isn't at the root, which [EMF requires](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format_Specification.html).
`x402@.service` already runs `docker compose up` in the foreground, so its stdout carries the raw
lines. This note records what happens when the unit writes them to a file.

## Setup

- A copy of the unit under user systemd: the same `up` flags plus `--no-log-prefix --no-color`,
  `ExecStartPre`, `ExecStop`, `Restart=on-failure`, `StandardOutput=append:<file>`,
  `StandardError=journal`.
- `node:22-alpine` printing EMF lines, app lines, stderr, long and split lines.
- The real `amazon-cloudwatch-agent` 1.300074 from the `.deb`, `endpoint_override` set to a local
  stub that records each request.
- Docker from the snap (29.8), Compose 5.5. The server runs Docker CE from Docker's apt repository.

## Compose to the file

| Case | Result |
| --- | --- |
| Raw lines | Unchanged, `_aws` at the root; 20 KB and 300 KB lines whole; a line written in two parts stays one line |
| Other lines in the file | `Attaching to facilitator-1`, a `facilitator-1 exited with code N` line with `\r\x1b[K`, and `ExecStartPre` output |
| Container stderr | Goes to Compose's stderr, not stdout. With `StandardError=journal` it isn't in the file |
| Crash loop | `startup_failed` in the file on every start |
| 200,000 lines in about 1 s | None lost, order kept |
| `docker logs` | Still works, the daemon's `json-file` logging is untouched |

## Can the path stop the container?

The ticker below measured its own stalls and wrote a heartbeat to a volume, apart from stdout.

| Case | Result |
| --- | --- |
| stdout to `/dev/full` (`ENOSPC` on every write) | Container and unit keep running, no restart, no stall |
| Compose frozen with `SIGSTOP` for 20 s, about 2 MB/s of logs | No stall, longest gap between ticks 102 ms |
| Compose killed with `-9` | Container keeps running, same `StartedAt`, the unit restarts Compose and it attaches again. About 2.5 s of lines missing from the file, no duplicates; they stay in `docker logs` |

An `ExecStartPre` that prints fails on `ENOSPC`, which stops the unit from starting. `x402-creds`
prints nothing, so this applies only to a step added later.

## Agent to CloudWatch (stub)

| Case | Result |
| --- | --- |
| Raw EMF line | Sent as is, with `x-amzn-logs-format: json/emf`, set by the agent itself |
| 2,000 lines at 200/s | All delivered |
| Agent stopped, 1,000 lines written, agent started | All delivered, no duplicates |
| Endpoint refused connections for 60 s, 2,400 lines at 20/s | All delivered after it returned |
| Longer outage, one mixed stream | The oldest lines dropped once 20,000 wait |
| `copytruncate`, 3 rotations at 50 lines/s | 2 of 1,000 lost |
| `copytruncate`, 2 rotations at about 2,000 lines/s | 80 of 40,000 lost, about 20 ms a rotation; the second run below found up to 250 ms |

The drop comes from `plugins/outputs/cloudwatchlogs/cloudwatchlogs.go`: the first line that looks
like EMF switches the whole destination to `AddEventNonBlocking`, which drops the oldest event once
20,000 wait. App lines in the same stream go with them.

## One file, two destinations

Two `collect_list` entries on one file, an `include` and an `exclude` filter on the EMF marker,
each to its own log group. 60,000 lines at about 1,000/s written with the endpoint down, half EMF:

| Destination | Delivered |
| --- | --- |
| App lines, ordinary blocking path | 30,000 of 30,000 |
| EMF lines, drop-oldest | 20,462 of 30,000, the newest ones |

So a split keeps every app line through an outage, and only old metric lines can go. It also gives
the two groups separate retention. [The agent's docs](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-Configuration-File-Details.html)
don't say whether one file can be listed twice; this test shows it works on this version.

The agent keys its saved offset by path, so two entries on one path share a state file. The second
entry therefore names a symlink to the same file:

| Case | Same path twice | Symlink for the second entry |
| --- | --- | --- |
| State files | 1 | 2 |
| `kill -9` and a clean restart, 8,000 lines | 1 duplicate | None lost, no duplicates |
| `kill -9` during an outage, 7,000 lines | Not run | None lost, no duplicates |

In each run the last line of the closing batch was unsent when the test stopped the agent.

## Credentials

- A profile with `credential_process` fails: the agent's file provider requires static keys
  (`cfg/aws/refreshable.go`, "does not contain static credentials"). No request left the agent.
- [`aws_signing_helper update`](https://docs.aws.amazon.com/rolesanywhere/latest/userguide/credential-helper.html)
  writes static keys to a file and refreshes about 5 minutes before expiry. The agent re-reads the
  file every 10 minutes (`defaultExpiryWindow`), so it can hold expired keys for up to about 5
  minutes.
- Key swapped in the file and the old key rejected by the stub with `ExpiredTokenException`: the
  agent moved to the new key after 9 min 26 s, with no gap in the delivered lines. The last 12 of
  3,600 lines were unsent when the test ended and the agent was killed.

## Second run: stderr, rotation and an outage across it

Run on 2026-11-03 after Oskar's review of #111, with the same agent (1.300074.0b1920), Docker snap
29.8, Compose 5.5.1 and logrotate 3.22.0 run as the user. The unit had the production flags,
`StandardOutput=append:out.log` and `StandardError=append:err.log`. The agent had the two entries
above (`out.log` with `exclude`, a symlink with `include`) and `err.log` as its own stream in the
app group. Every line carried a sequence number.

### stderr in its own file

| Source | `out.log` | `err.log` |
| --- | --- | --- |
| Container stdout | All | None |
| Container stderr | None | All |
| `ExecStartPre` | Its stdout | Its stderr |
| `Attaching to facilitator-1`, and `\r\x1b[K... exited with code N` | Yes, each start and exit | No |
| Compose's progress lines (`Container ... Started`, `Stopping`) | No | Yes, each with a leading space |
| A crash loop | `startup_failed` each start | The container's stderr each start |

`out.log` kept the raw lines: every EMF line started with `{"_aws":`. `err.log` reached the app
group as its own stream, 50 of 50 lines.

### Rotation with both entries, endpoint up

`copytruncate` while the container wrote a mixed stream, half EMF:

| Rate | Rotations | Lost a rotation | Duplicates |
| --- | --- | --- | --- |
| 50 lines/s | 3 | 1 to 12 lines, 20 to 240 ms | 0 |
| 2,000 lines/s | 8 | 20 to 500 lines, mean 353, about 175 ms | 0 |
| `err.log`, 100 lines/s | 1 | 5 lines, 50 ms | 0 |

Both entries lose about the same. No line reached the wrong group. Most of the gap is the agent's
poll: it checks the file every 250 ms (`plugins/inputs/logfile/tail/watch/polling.go`), so up to
250 ms of the old file is unread when it's truncated, and those lines are the tail of the rotated
file. Only 0 to 22 lines a rotation (up to about 11 ms) fell between logrotate's copy and its
truncate, and are in no file.

### An outage across a rotation

A 6 MB file, then 200 lines/s, half EMF. The endpoint went down at +10 s, the file rotated at
+40 s, and the endpoint came back at +70 s.

| Destination | Delivered | Lost | Where the lost lines are |
| --- | --- | --- | --- |
| App group | 7,504 of 10,000 | 2,496 | 2,494 in the rotated file, every app line after the entry stopped reading; 2 in no file |
| Metrics group | 9,985 of 10,000 | 15 | 13 in the rotated file (the usual gap), 2 in no file |
| `err.log`, not rotated | 1,000 of 1,000 | 0 | |

The app entry stopped reading about 5 s into the outage, once its sending blocked. At the
rotation the file shrank below its offset, so after the outage it reopened at 0 and sent every
line written since. The lines between were in `out.log.1` only. It resumed 23 s after the
endpoint came back, as the agent's retry waits up to a minute. No duplicates. So Oskar's reasoning
holds: a rotation during an outage longer than a few seconds loses every app line since the
block, and keeps them on the server.

### Lines that start with whitespace join the line before

The agent's default `multi_line_start_pattern` is `^[\S]`, so a line that starts with a space or
`\r` joins the previous event. Compose's exit line, `\r\x1b[K... exited with code N`, arrived
inside the container's last stdout line, and Compose's progress lines inside the previous stderr
line. If the last stdout line before an exit is EMF, as the adapter's flush at shutdown makes
likely, the exit line would join it: the event still matches the `include` filter, isn't valid
JSON, and its metrics are lost. Not tested. #113 sets a pattern that starts an event at every
line, and tests that an EMF line before an exit keeps its metrics.

### Not run

- The case where the new file grows past the old offset before the agent resumes: by `tail.go`,
  duplicates and one garbled line rather than more loss.
- `err.log` rotated during an outage, an agent restart across a rotation, logrotate from its timer.

## Not verified

- CloudWatch really extracting metrics from these lines. Task and ADR ask for it once, live.
- `PutMetricData`: the stub couldn't answer its protocol.
- The real signing helper, a restart of `dockerd`, Docker CE.
