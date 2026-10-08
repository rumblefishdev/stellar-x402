# Scheme: `upto` on `Stellar`

## Versions supported

- ❌ `v1`
- ✅ `v2`

## Supported Networks

This spec uses [CAIP-2](https://namespaces.chainagnostic.org/stellar/caip2) identifiers:

- `stellar:pubnet` — Stellar mainnet
- `stellar:testnet` — Stellar testnet

## Summary

The `upto` scheme on Stellar lets a client authorize a **maximum amount** of a [SEP-41] token once, and lets the facilitator it chose settle the **actual amount** (from `0` up to that maximum) after the resource server has measured usage. It meets the five core properties of [`scheme_upto.md`](./scheme_upto.md).

Settlement goes through the **UptoProxy** Soroban contract, deployed at one [canonical address](#canonical-uptoproxy-deployments) per network. The client signs one Soroban authorization entry for `UptoProxy.settle_upto` with a nested `token.approve`; it never builds, signs or pays for a transaction. The facilitator swaps in the actual amount, adds its own authorization and submits the transaction, paying all fees.

> [!NOTE]
> **This design ships a Soroban contract.** SEP-41 allowances alone (`approve` + `transfer_from` by the facilitator) cannot bind the recipient or enforce single use: an allowance lets its spender move the tokens to any address, any number of times, until it expires or is used up. The contract enforces the recipient, the facilitator, the time window and the nonce on chain. See [Security Considerations](#security-considerations).

> [!NOTE]
> **Scope:** [SEP-41]-compliant Soroban tokens, including Stellar Asset Contracts (SAC) for classic assets.

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `402 Payment Required` and a `PAYMENT-REQUIRED` header. The `upto` entry carries `amount` (the maximum), `asset`, `payTo`, `maxTimeoutSeconds` and `extra.facilitatorAddress`.
3. **Client** builds the authorization entry for `UptoProxy.settle_upto` described in [Authorization Entry](#authorization-entry): the canonical proxy, the token, the recipient, the facilitator, the maximum, a fresh random 32-byte nonce, a validity window and a nested `token.approve` of the maximum to the proxy.
4. **Client** signs the entry with its wallet, with `signatureExpirationLedger = currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`.
5. **Client** sends a new request with the `PaymentPayload`, whose `payload.authorization` is the signed entry as base64 XDR.
6. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator**'s `/verify` endpoint.
7. **Facilitator** decodes the entry, checks it against the requirements and simulates the settlement at the full maximum ([Verification](#facilitator-verification-rules-must)).
8. **Resource Server**, on a valid response, runs the request and measures usage.
9. **Resource Server** calls `/settle` with the same `PaymentPayload` and `PaymentRequirements` whose `amount` is now the **actual amount** ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)).
10. **Facilitator** re-verifies against the signed maximum, builds `settle_upto` with the actual amount, simulates it, submits it, and returns a `SettlementResponse` with the amount charged ([Settlement](#settlement-logic)).
11. **Resource Server** returns the resource to the **Client**.

## `PaymentRequirements` for `upto`

```json
{
  "scheme": "upto",
  "network": "stellar:testnet",
  "amount": "5000000",
  "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  "maxTimeoutSeconds": 300,
  "extra": {
    "areFeesSponsored": true,
    "facilitatorAddress": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
  }
}
```

| Field               | Type     | Required | Description                                                                                                                     |
| ------------------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | `"upto"`                                                                                                                        |
| `network`           | `string` | Required | `stellar:pubnet` or `stellar:testnet`                                                                                           |
| `amount`            | `string` | Required | Phase-dependent: the maximum at verification, the actual amount at settlement. Atomic units, a positive integer at verification |
| `asset`             | `string` | Required | The SEP-41 token contract address (`C...`)                                                                                      |
| `payTo`             | `string` | Required | The recipient address (`G...` or `C...`)                                                                                        |
| `maxTimeoutSeconds` | `number` | Required | Bounds the authorization's lifetime (see [Authorization Entry](#authorization-entry))                                           |
| `extra`             | `object` | Required | See below                                                                                                                       |

**`extra` fields:**

- `extra.areFeesSponsored`: MUST be `true`. The facilitator pays every fee; the client never pays one.
- `extra.facilitatorAddress`: The Stellar account (`G...`) that will settle the payment. The facilitator publishes it in the `extra` of its `/supported` entry for `upto`, and the resource server copies it into its requirements. The client signs it as the `facilitator` argument, so only that facilitator can settle.

The proxy address is **not** a requirements field. Clients and facilitators MUST use the [canonical deployment](#canonical-uptoproxy-deployments) for the network, so a resource server cannot point a client at a different contract.

## PaymentPayload `payload` Field

```json
{
  "authorization": "AAAAAQAAAAAAAAAA..."
}
```

`authorization` is the base64 XDR of one signed `SorobanAuthorizationEntry`. Every argument of `settle_upto` except `actual_amount` can be read from it: `from` from the credentials, `allowance_expiration_ledger` from the `approve` sub-invocation, and the rest from the root invocation.

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "stellar:testnet",
    "amount": "5000000",
    "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    "payTo": "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    "maxTimeoutSeconds": 300,
    "extra": {
      "areFeesSponsored": true,
      "facilitatorAddress": "GBM7Q4MDPBB4QOYUKRZIOO2PZDIZIO4YX44AKFJNZPR3SDP6EKC7BNLM"
    }
  },
  "payload": {
    "authorization": "AAAAAQAAAAAAAAAA..."
  }
}
```

## Authorization Entry

The client signs exactly one entry with this tree:

```
credentials: sorobanCredentialsAddress or sorobanCredentialsAddressV2
  address                   = from (the client)
  nonce                     = random int64 (Soroban's own replay nonce)
  signatureExpirationLedger = allowance_expiration_ledger
rootInvocation:
  contract = UptoProxy (canonical), function = "settle_upto"
  args     = [token, to, facilitator, max_amount, nonce, valid_after, deadline]
  subInvocations:
    - contract = token, function = "approve"
      args     = [from, UptoProxy, max_amount, allowance_expiration_ledger]
      subInvocations: []
```

| Value                         | Type         | Set to                                                                                        |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `token`                       | `Address`    | `requirements.asset`                                                                          |
| `to`                          | `Address`    | `requirements.payTo`                                                                          |
| `facilitator`                 | `Address`    | `requirements.extra.facilitatorAddress`                                                       |
| `max_amount`                  | `I128`       | `requirements.amount`                                                                         |
| `nonce`                       | `BytesN<32>` | 32 random bytes from a cryptographically secure source, fresh for every payment               |
| `valid_after`                 | `U64`        | Unix seconds, at most the current time. Clients MAY back-date it by up to 60 s for clock skew |
| `deadline`                    | `U64`        | Unix seconds, at most `now + maxTimeoutSeconds`                                               |
| `allowance_expiration_ledger` | `U32`        | `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`                            |

- The root `args` are the exact vector the contract passes to `from.require_auth_for_args`, in this order and with these types. `from` and `actual_amount` are not in it: `from` is the signer, and `actual_amount` is chosen by the facilitator within the signed maximum.
- `estimatedLedgerSeconds` follows [`scheme_exact_stellar.md`](../exact/scheme_exact_stellar.md): the current network estimate when available, else `5`.
- The tree is fully determined by the requirements and the client's own choices, so the client MAY build it directly without simulation. A client that wants a preflight check MAY simulate a draft `settle_upto` call with `actual_amount = max_amount` in recording mode; the draft's source account MUST then be `facilitatorAddress`, because with the client as source the simulation records source-account credentials and returns nothing to sign. That simulation needs a balance of at least `max_amount`.
- Smart-wallet (`C...`) clients with per-context policies MUST allow both contexts: `settle_upto` on the proxy and `approve` on the token.

## Facilitator Verification Rules (MUST)

A facilitator verifying an `upto` payment on Stellar MUST enforce all of the following. At `/verify`, `requirements.amount` is the maximum.

### 1. Protocol Validation

- `x402Version` MUST be `2`.
- `payload.accepted.scheme` and `requirements.scheme` MUST be `"upto"`.
- `payload.accepted.network` MUST equal `requirements.network`.
- `requirements.extra.facilitatorAddress` MUST be one of this facilitator's own addresses.

### 2. Authorization Entry

- `payload.authorization` MUST decode to exactly one `SorobanAuthorizationEntry`.
- Its credentials MUST be `sorobanCredentialsAddress` or `sorobanCredentialsAddressV2` (see [`scheme_exact_stellar.md` §3](../exact/scheme_exact_stellar.md#3-authorization-entries) for the two preimages). `sorobanCredentialsSourceAccount` and `sorobanCredentialsAddressWithDelegates` MUST be rejected.
- Its `rootInvocation` MUST equal, byte for byte as XDR, the tree in [Authorization Entry](#authorization-entry) built from the requirements and from the entry's own `from`, `nonce`, `valid_after`, `deadline` and `allowance_expiration_ledger`. In particular:
  - the root contract is the canonical UptoProxy for the network, and the function is `settle_upto`;
  - `token == requirements.asset`, `to == requirements.payTo`, `facilitator == requirements.extra.facilitatorAddress`, `max_amount == requirements.amount`;
  - there is exactly one sub-invocation, `approve` on `token` with `[from, UptoProxy, max_amount, allowance_expiration_ledger]`, and it has no sub-invocations of its own.
- The signature MUST be valid for `from`.

### 3. Time Bounds

- `signatureExpirationLedger` MUST equal `allowance_expiration_ledger`, MUST be at least the current ledger, and MUST NOT exceed `currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds)`.
- `valid_after <= now <= deadline`, and `deadline` MUST NOT exceed `now + maxTimeoutSeconds`.

### 4. Nonce

- `UptoProxy.is_nonce_used(from, nonce)` MUST return `false`.
- `(from, nonce)` MUST NOT be in the facilitator's own record of settled nonces (see [Settlement](#settlement-logic)). The contract forgets a nonce once its temporary entry expires, so the record is what stops a later payload that reuses it.

### 5. 🚨 Facilitator Safety

- `from` MUST NOT be any of the facilitator's addresses, including fee-bump and channel accounts.
- `to` MUST NOT be the UptoProxy address.
- The facilitator's own authorization MUST NOT come from the client: the facilitator adds it at settlement.

### 6. Simulation

- The facilitator MUST simulate `settle_upto` with `actual_amount = max_amount` (the worst case), the client's entry and its own authorization, against the current ledger state.
- The simulation MUST succeed.
- The only balance changes MUST be `from` decreasing by `max_amount` and `to` increasing by `max_amount`. The only other write allowed is the `(from, UptoProxy)` allowance on `token` and the proxy's nonce entry. A non-SAC token may emit extra events or charge transfer fees, so facilitators MUST check balance changes, not only events.

## Settlement Logic

### Phase 1: Settle-Time Verification

At `/settle`, `requirements.amount` is the **actual** amount ([`scheme_upto.md` §5](./scheme_upto.md#5-phase-dependent-amount-semantics-in-paymentrequirements)).

1. Run every [verification rule](#facilitator-verification-rules-must) again, independently of any earlier `/verify`, but against the **signed** `max_amount` read from the entry, not against `requirements.amount`.
2. Require `0 <= requirements.amount <= max_amount`, else fail with `invalid_upto_stellar_payload_settlement_exceeds_amount`.

### Phase 2: Zero Settlement

If `requirements.amount` is `0`, the facilitator MUST NOT submit a transaction. It returns `success: true`, `transaction: ""` and `amount: "0"`. The nonce stays unused on chain until the authorization expires; the facilitator SHOULD add it to its settled-nonce record anyway.

### Phase 3: Transaction Construction

1. Build one `invokeHostFunction` operation calling `UptoProxy.settle_upto` with all ten arguments: `[token, from, to, facilitator, max_amount, actual_amount, nonce, valid_after, deadline, allowance_expiration_ledger]`, where `actual_amount = requirements.amount`.
2. Attach the client's entry **unchanged**.
3. Authorize the facilitator's `require_auth()`. The facilitator SHOULD be the **operation source**, so its authorization is source-account credentials and needs no separate entry. Otherwise it adds its own `sorobanCredentialsAddress` entry for the full call with no sub-invocations.
4. The **transaction source** is the facilitator's account or a channel account the facilitator controls. The facilitator MAY wrap the transaction in a fee bump.
5. Simulate in enforcing mode with the actual amount. The simulation MUST succeed, MUST leave the client's tree unchanged, and the only balance changes MUST be `from` decreasing and `to` increasing by `actual_amount`.
6. Set the fee and Soroban resource data from that simulation, as in [`scheme_exact_stellar.md` — Transaction Fees](../exact/scheme_exact_stellar.md#transaction-fees).

### Phase 4: Submission

1. Durably record `(from, nonce)` as settled **before** submitting, and never delete it.
2. Sign and submit with RPC `sendTransaction`. The status MUST be `PENDING`; then poll for `SUCCESS` or `FAILED`.
3. A successful settlement emits the `upto_settled` event (see [Event](#event)).
4. If the transaction was sent but its outcome can't be established, the facilitator MAY return `settlement_pending` with the transaction hash, as in [x402 v2 §9](../../x402-specification-v2.md#9-error-handling).

### Phase 5: `SettlementResponse`

```json
{
  "success": true,
  "transaction": "d66a76ffa2198e7c78ae67e6ad04202bf81633f95986c81debc86fa76cd8d672",
  "network": "stellar:testnet",
  "payer": "GCADNNOZTTKEGX3Z2TA6O2MLPVPMPXL3OLI6UWWQNWZSEANFDOMNE6F6",
  "amount": "1250000"
}
```

- `transaction`: the transaction hash (64 hex characters), or `""` for a zero settlement.
- `payer`: the client's address (`from`), not the facilitator's.
- `amount`: the amount charged in atomic units, which may be `"0"`.

## Transaction Fees

The facilitator pays every fee and MUST derive it as `exact` does: a fresh simulation at settle time plus an inclusion buffer of at least 100 stroops.

Facilitators MAY expose `maxTransactionFeeStroops` as a safety ceiling and reject verification above it with `invalid_upto_stellar_payload_fee_exceeds_maximum`. Its default MUST leave room for rent: a settlement that creates or extends a ledger entry (for example the first payment of the day, which extends the proxy's TTL) pays that rent. On testnet a normal settlement cost 29,000–44,000 stroops, and a settlement that paid rent cost 151,550. `exact`'s 50,000-stroop default is too low for `upto`; we suggest 250,000.

## Error Codes

The `upto` scheme on Stellar uses the standard x402 error codes, plus these:

| Error code                                                 | When                                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `invalid_upto_stellar_payload_malformed`                   | `payload.authorization` is missing or isn't one `SorobanAuthorizationEntry`                        |
| `invalid_upto_stellar_payload_unsupported_credential_type` | The credentials aren't `Address` or `AddressV2`                                                    |
| `invalid_upto_stellar_payload_wrong_contract`              | The root contract isn't the canonical UptoProxy, or the function isn't `settle_upto`               |
| `invalid_upto_stellar_payload_auth_mismatch`               | The tree doesn't match the requirements (token, recipient, facilitator, maximum or `approve`)      |
| `invalid_upto_stellar_payload_missing_payer_signature`     | The signature is missing or invalid                                                                |
| `invalid_upto_stellar_signature_expiration_too_far`        | `signatureExpirationLedger` is past the `maxTimeoutSeconds` bound, or differs from the allowance   |
| `invalid_upto_stellar_payload_not_yet_valid`               | `now < valid_after` (contract error `NotYetValid`)                                                 |
| `invalid_upto_stellar_payload_expired`                     | `now > deadline` or the ledger is past the allowance (contract error `Expired`)                    |
| `invalid_upto_stellar_payload_nonce_used`                  | The nonce is used on chain or in the facilitator's record (contract error `NonceUsed`)             |
| `invalid_upto_stellar_payload_facilitator_is_payer`        | `from` is a facilitator address                                                                    |
| `invalid_upto_stellar_payload_invalid_recipient`           | `to` is the proxy or `from` (contract errors `InvalidRecipient`, `SelfPayment`)                    |
| `invalid_upto_stellar_payload_settlement_exceeds_amount`   | `requirements.amount` at settlement exceeds the signed maximum (contract error `AmountExceedsMax`) |
| `invalid_upto_stellar_payload_simulation_failed`           | Simulation failed for any other reason, including a low balance                                    |
| `invalid_upto_stellar_payload_unexpected_balance_change`   | Simulation shows balance changes other than `from` and `to`                                        |
| `invalid_upto_stellar_payload_fee_exceeds_maximum`         | The simulated fee exceeds `maxTransactionFeeStroops`                                               |

## Security Considerations

1. **Why a contract.** With SEP-41 allowances alone, the client would `approve` the facilitator, which could then `transfer_from` to any recipient, any number of times, until the allowance runs out or expires. UptoProxy binds the recipient, the facilitator, the maximum, the window and a single-use nonce into the client's signature and checks them on chain. It is immutable (no admin, no upgrade) and never holds funds.
2. **Replay is refused twice.** Reusing a signed entry fails in Soroban's own authorization (`Error(Auth, ExistingValue)`); re-signing the same `(from, nonce)` fails in the contract (`NonceUsed`) while its entry lives. The facilitator's settled-nonce record covers the time after the entry expires.
3. **Recipient and facilitator binding.** `to` and `facilitator` are signed, and the contract calls `facilitator.require_auth()`. Another party that sees the payload cannot settle it, even for a smaller amount, and a facilitator that rewrites `facilitator` to itself breaks the client's signature.
4. **Leftover allowance.** `approve` sets the proxy's allowance to `max_amount`, and `transfer_from` spends `actual_amount`, so `max_amount - actual_amount` stays approved to the proxy until `allowance_expiration_ledger`. Only the proxy can spend it, and only through `settle_upto` with a new client signature and an unused nonce. A client that wants it cleared earlier can set its allowance to the proxy to `0`.
5. **Nonce scope.** The nonce is per `from`, not per facilitator. A client that signs the same nonce for two facilitators has signed two payments, and the first one settled wins on chain.
6. **Server trust.** As on every network, the client trusts the resource server to charge for real usage, up to the maximum.
7. **Fee exposure.** The facilitator pays for failed transactions too. Simulating immediately before submission and capping fees bound that cost; a state change between simulation and inclusion can still make a settlement fail and be charged.
8. **Throughput.** One payment is one transaction. Settlements from different clients don't contend, and with N channel accounts a facilitator can land N per ledger, up to the network's share of ledger capacity.

## Appendix

### Canonical UptoProxy Deployments

| Network           | Contract address                                           | WASM hash                                                          |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `stellar:testnet` | `CC3VX7N6ILD63V7FS2JA7XUDX4DMHYEJXRZDOMU7GVW76XYINOAZ7OYU` | `be2ba12160a7e3e1a93ed0cb457b7e93cd6ed4c725cb51aeeb87313b45dd0b34` |
| `stellar:pubnet`  | TBD                                                        | TBD                                                                |

A Soroban contract address depends on the deployer and a salt. The contract is deployed with its WASM hash as the salt, so a code change gets a new address. Every new address is a change to this table.

Source: [`contracts/upto-proxy`](https://github.com/rumblefishdev/stellar-x402/tree/develop/contracts/upto-proxy) (Apache-2.0). Where the source lives long-term is an open question for maintainers.

### Contract Interface

```rust
pub fn settle_upto(
    env: Env,
    token: Address,
    from: Address,
    to: Address,
    facilitator: Address,
    max_amount: i128,
    actual_amount: i128,
    nonce: BytesN<32>,
    valid_after: u64,
    deadline: u64,
    allowance_expiration_ledger: u32,
) -> Result<(), UptoError>;

pub fn is_nonce_used(env: Env, from: Address, nonce: BytesN<32>) -> bool;
```

`settle_upto` runs in this order; any error rolls the whole call back:

1. `max_amount <= 0` or `actual_amount < 0` → `InvalidAmount`; `actual_amount > max_amount` → `AmountExceedsMax`.
2. `from == to` → `SelfPayment`; `to == UptoProxy` → `InvalidRecipient`.
3. `from.require_auth_for_args([token, to, facilitator, max_amount, nonce, valid_after, deadline])`.
4. `facilitator.require_auth()`.
5. `now < valid_after` → `NotYetValid`; `now > deadline` → `Expired`.
6. `allowance_expiration_ledger` before the current ledger → `Expired`; beyond the maximum TTL → `InvalidAllowanceExpiration`.
7. `(from, nonce)` already stored → `NonceUsed`; otherwise store it in temporary storage until at least `allowance_expiration_ledger`.
8. `token.approve(from, UptoProxy, max_amount, allowance_expiration_ledger)`.
9. If `actual_amount > 0`: `token.transfer_from(UptoProxy, from, to, actual_amount)`.
10. Emit `upto_settled`.

### Contract Errors

| Code | Name                         |
| ---- | ---------------------------- |
| 1    | `InvalidAmount`              |
| 2    | `AmountExceedsMax`           |
| 3    | `SelfPayment`                |
| 4    | `NotYetValid`                |
| 5    | `Expired`                    |
| 6    | `InvalidAllowanceExpiration` |
| 7    | `NonceUsed`                  |
| 8    | `InvalidRecipient`           |

### Event

`upto_settled`, emitted on every successful settlement including zero:

- topics: `"upto_settled"`, `token`, `from`, `to`
- data (map): `facilitator`, `max_amount`, `actual_amount`, `nonce`

### Testnet Evidence

An end-to-end suite ran 49 scenarios on testnet on 2026-10-08 against the canonical testnet deployment, across Circle testnet USDC, a classic asset through its SAC, and a non-SAC SEP-41 token: settlements below, at and at zero of the maximum, two payments from one payer in one ledger, every rejection above, and tampering with each signed value. Report with all 21 transaction hashes: [UptoProxy testnet report](https://github.com/rumblefishdev/stellar-x402/blob/develop/docs/upto-proxy-testnet-report.md).

[SEP-41]: https://stellar.org/protocol/sep-41
