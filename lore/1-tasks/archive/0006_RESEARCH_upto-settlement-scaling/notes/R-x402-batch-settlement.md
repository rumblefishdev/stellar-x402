---
title: "x402 batch-settlement and auth-capture schemes (upstream)"
type: research
status: mature
spawns:
  - notes/S-session-aggregation.md
tags: [x402, spec, batch-settlement, auth-capture, session]
links:
  - ../sources/scheme_batch_settlement.md
  - ../sources/scheme_batch_settlement_evm.md
  - ../sources/scheme_batch_settlement_cloudflare.md
  - ../sources/scheme_auth_capture.md
history:
  - date: "2026-10-05"
    status: mature
    who: claude
    note: "Read upstream specs at x402 751590a (copies in sources/) for question 1"
---

# x402 batch-settlement and auth-capture schemes (upstream)

Upstream x402 (`x402-foundation/x402`, commit `751590a`, 2026-10-02) now has two more schemes
next to `exact` and `upto`. Copies are in [`sources/`](../sources/). Both matter for question 1,
because **the protocol already has a place for "many requests, one settlement"**, and it is not
`upto`.

## `upto` rules out multi-settlement

[`scheme_upto.md`](../../../archive/0002_RESEARCH_upto-proxy-design-on-soroban/sources/scheme_upto.md)
requires single use and lists "multi-settlement / streaming", "recurring payments" and
"open-ended allowances" as out of scope. In `upto`, verify and settle happen in one pass for each
request, and the result carries a transaction hash.

## `batch-settlement`

[Core spec](../sources/scheme_batch_settlement.md). The client attaches a commitment to every
request and is served at once. Settlement **stores** the commitment and returns a commitment
identifier, not a transaction hash. Value moves later. Pricing is dynamic: the client commits to
up to `PaymentRequirements.amount` per request, and the actual charge goes back in
`PAYMENT-RESPONSE`. Each network binding must define the commitment format, the verification
rules, storage, double-spend prevention, expiry, redemption, and the trust model, which is either
capital-backed or credit-backed.

**EVM binding** ([source](../sources/scheme_batch_settlement_evm.md)): unidirectional payment
channels backed by an escrow contract.

- **Contract `x402BatchSettlement`.**
  - Calls: `claim`, `claimWithSignature` (batched rows under one `receiverAuthorizer`
    signature), `settle(receiver, token)`, `refund` / `refundWithSignature`, and
    `initiateWithdraw` / `finalizeWithdraw`.
  - The channel is `ChannelConfig{payer, payerAuthorizer, receiver, receiverAuthorizer, token,
    withdrawDelay, salt}`, and `channelId` is the hash of that config.
  - A channel is opened by the first deposit, which uses ERC-3009 or Permit2 and is submitted by
    the facilitator.
- **Voucher.** `{channelId, maxClaimableAmount, signature}`, where the amount is **cumulative**.
  It has no nonce and no expiry, because a higher total replaces a lower one.
  - **Signer:** `payerAuthorizer`, which is an EOA key, so the server can check a voucher with no
    RPC call.
  - **Dynamic pricing:** each voucher equals the charged total so far plus this request's maximum.
    The server then records only the actual price.
- **Transactions per session.** One deposit (plus top-ups). **Zero per request.** Claims and
  settles batch many channels per transaction.
- **Close.**
  - Cooperative: refund with a signature, with a nonce per channel.
  - Unilateral: `initiateWithdraw`, then `finalizeWithdraw` after `withdrawDelay` (15 min–30
    days). The server must claim before then.
- **Trust.** The client risks about one request's maximum above its actual charges. The seller is
  protected by the escrow, as long as it claims in time. The server takes a per-channel lock and
  returns `channel_busy`.

**Cloudflare binding** ([source](../sources/scheme_batch_settlement_cloudflare.md)): credit-backed
and fully off-chain. Cloudflare is merchant of record. Clients sign requests with Web Bot Auth
(ed25519, RFC 9421) tied to a billing identity, and payment is a fiat invoice. Nothing for an
on-chain facilitator to do.

## `auth-capture`

[Core spec](../sources/scheme_auth_capture.md). The client authorizes a maximum as a hold, then:

- `capture` pays out, **repeatable up to the hold**;
- `void` releases the rest;
- `refund` is repeatable up to the captured amount, until `refundDeadline`;
- `reclaim` lets the client take the hold back after `captureDeadline`.

It allows periodic captures against one hold, but **every capture is on-chain**, so it cuts
signatures, not transactions.

## Hard parts for a Soroban binding of batch-settlement

- **Signatures.** EIP-712, `ecrecover` and EIP-1271 do not exist on Soroban. Use a committed
  ed25519 `payerAuthorizer` key, checked with `env.crypto().ed25519_verify` over a hash of the
  voucher's XDR, with network and contract bound in.
  - Using the payer's `require_auth` instead would put auth entries, each with a nonce and an
    expiry ledger, into the claim transaction. That clashes with vouchers that never expire.
- **Deposit.** ERC-3009 and Permit2 are not needed. A deposit is a plain SEP-41 `transfer` under
  the payer's address auth.
- **Storage.** Channel entries are persistent and need TTL extension for channels that live up to
  30 days.
- **Batched claims.** They are bounded by the 400-entry footprint and the transaction size.
