---
id: "0053"
title: "Catalog resources whose mimeType is an empty string"
type: BUG
status: backlog
related_adr: ["0008"]
related_tasks: ["0030", "0032", "0028"]
tags: [bazaar, discovery, priority-medium, effort-small]
links: []
history:
  - date: "2026-10-22"
    status: backlog
    who: karolkow
    note: "Found in a local gate run of the 0028 harness; fix decided: treat an empty mimeType as absent."
---

# Catalog resources whose mimeType is an empty string

## Summary

As a seller who sets no `mimeType` on a route, I want my resource cataloged after a paid call, so
that the default upstream server setup gets listed like any other.

## Context

- Upstream's resource server sends `mimeType: routeConfig.mimeType || ""` (`@x402/core` 2.28.0),
  so every route without a `mimeType` sends an empty string. Spec v2 makes the field optional.
- Our validator (`packages/bazaar/src/validate.ts`, from 0030) accepts an absent `mimeType` but
  refuses `""` as `invalid_info` ("resource.mimeType is not a valid media type").
- Measured 2026-10-22: in a local gate run, all 16 HTTP settlements from the upstream e2e servers
  were refused for this. Of 40 sellers sampled from the CDP catalog (one per host, from the first
  1,000 of 31,851 entries), 4 sent `""`, 35 `application/json`, 1 gave no 402.
- Cataloging never blocks a settlement (ADR 0008), so payments are not affected; the listing is
  lost silently, seen only as a `catalog_rejected` log line.

## Implementation

- Treat `mimeType: ""` as absent: the entry is cataloged without a `mimeType`.
- Every other value keeps the RFC 6838 check.

## Acceptance Criteria

- [ ] Given a settled payment whose `resource.mimeType` is `""`, when it is validated, then it is
      accepted and the entry carries no `mimeType`
- [ ] Given `resource.mimeType` of `" "` or `"json"`, when it is validated, then it is still
      refused as `invalid_info`
