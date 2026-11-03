---
id: "0100"
title: "Find out whether the server can have a TPM before mainnet"
type: FEATURE
status: backlog
milestone: 2
related_adr: ["0013"]
related_tasks: ["0026", "0038"]
tags: [deploy, security, mainnet, priority-low, effort-small, platform]
links: []
history:
  - date: "2026-11-03"
    status: backlog
    who: stkrolikiewicz
    note: "Spawned from 0026: karczuRF's review of #117."
---

# Find out whether the server can have a TPM before mainnet

## Summary

The systemd credentials on the facilitator's server are encrypted in `host` mode, with a key on
the server's own disk (ADR 0013). A TPM would bind them to the board, so a copied disk couldn't
open them: ADR 0013's first upgrade. Today the firmware exposes none. Before mainnet (0038), find
out whether the board can have one, and if it can, move the credentials to it.

## Context

- Checked on 2026-11-03 (#117): no ACPI `TPM2` or `TCPA` table, no SMBIOS type 43 and no
  `/dev/tpm*` on the ASRock Rack B450D4U-V1L (BIOS L2.12) with a Ryzen 9 3900.
- Not checked: Ryzen 3000 has AMD's fTPM in its firmware, usually switched in the BIOS, and boards
  of this series have a TPM header. Most likely the fTPM is off.
- The server is shared with the explorer, so a reboot is agreed with its team.
- A TPM-bound credential dies with the board or a cleared fTPM. The seal key is in the backup
  secret; the others must then be written again from their sources.

## Implementation

- Look for the fTPM in the BIOS through Hetzner's KVM console, or ask Hetzner's support.
- If the board can have one: turn it on (a reboot), then encrypt every credential again in
  `host+tpm2` mode: the seal key, both AppRole IDs, the database password and URL, the RPC URLs
  and the tunnel token. Update the runbook's `systemd-creds encrypt` commands, anything in the
  playbook that assumes `host` mode, and ADR 0013.
- If it can't: record why here and in ADR 0013, and keep `host` mode, as ADR 0013 accepts.

## Acceptance Criteria

- [ ] Given the server's BIOS or Hetzner's answer, when it is checked, then this task records whether the board can have a TPM
- [ ] Given a TPM, when it is on, then every credential is encrypted in `host+tpm2` mode, every unit starts after a reboot, and the runbook and ADR 0013 say so
- [ ] Given no TPM, when that is known, then ADR 0013 records it and `host` mode stays
- [ ] Given mainnet (0038), when it is deployed, then this task is closed first
