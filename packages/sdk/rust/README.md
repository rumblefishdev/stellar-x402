# stellar-x402 (Rust)

Charge for an HTTP route with [x402](https://www.x402.org) payments on Stellar, from a Rust
service. The seller signs nothing and holds no key: the buyer signs the payment, and a facilitator
checks it, settles it and pays the network fee.

Part 1 of the Rust SDK (task 0136): the seller's side of the `exact` scheme. Not published yet; the
buyer's side, `upto` and more frameworks are part 2 (task 0140).

## Charge for an axum route

Not on crates.io before part 2, so from this repository:

```toml
stellar-x402 = { git = "https://github.com/rumblefishdev/stellar-x402", branch = "develop" }
```

The axum layer is the feature `axum`, on by default, for axum 0.8.

```rust,no_run
use axum::{routing::get, Router};
use serde_json::json;
use stellar_x402::axum::PaymentGate;
use stellar_x402::{Facilitator, Listing, Network, Price};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let facilitator = Facilitator::new("https://x402-facilitator.sorobanscan.com")?;
    // Reads what the facilitator supports; a seller with a wrong URL does not start.
    let gate = PaymentGate::connect(facilitator).await?;

    let paid = gate
        .charge(
            Network::Testnet,
            "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3",
            Price::usdc("0.001")?,
        )?
        .description("Current temperature for a city")
        // Asks the facilitator's catalog (the Bazaar) to list the route.
        .listing(Listing::query(json!({ "city": "Warsaw" })));

    let app = Router::new().route("/weather", get(|| async { "14 °C" }).route_layer(paid));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:4020").await?;
    axum::serve(listener, app).await?;
    Ok(())
}
```

`route_layer`, not `layer`: `layer` also wraps axum's answer to a method the route does not have,
so a `POST` or a browser's `OPTIONS` preflight would get 402 in place of 405.

`examples/weather.rs` is the whole seller, the twin of the TypeScript `examples/http-api`:

```bash
SELLER_ADDRESS=G... cargo run --example weather
curl -i "http://localhost:4020/weather?city=Warsaw"   # 402 with the PAYMENT-REQUIRED header
```

## What a request gets

| Request                                              | Answer                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| No payment, or a `PAYMENT-SIGNATURE` nobody can read | 402, the terms in `PAYMENT-REQUIRED`                                              |
| A payment made for other terms                       | 402, `error: "No matching payment requirements"`; the facilitator is not asked    |
| A payment the facilitator refuses                    | 402, `error` is its reason code; the body adds its message                        |
| A payment the facilitator cannot read (its 400)      | 402, `error: "invalid_payload"`; the route does not run                           |
| A valid payment, and the route answers below 400     | the route's answer, with `PAYMENT-RESPONSE` and the transaction's hash            |
| A valid payment, and the route answers 400 or above  | the route's answer; nothing is settled, so the buyer pays nothing                 |
| The route answered, and the facilitator won't settle | 402, `PAYMENT-RESPONSE` with the reason; the route's answer is not sent           |
| The facilitator gives no answer to act on            | 502 `facilitator_unavailable`; the cause goes to the seller's `on_event`, not out |

A paid answer keeps the route's own `Cache-Control`, with `private` added, so a shared cache does
not keep it.

The payment is checked, the route runs and the payment is settled inside the request. A buyer who
disconnects ends all three where they are: during `/settle` the facilitator may still move the
money with no event to say so, and after the route ran its work is not paid for. Settling apart
from the request is part 2's.

The 402 is held equal to what upstream's `@x402/express` 2.28.0 sends for the same route: a test
compares the two (`tests/fixtures/payment-required-upstream.json`).

Two things the seller gets that upstream's middleware does not pass on:

- **The facilitator's message with its reason.** A refusal's body is
  `{"error": "<reason code>", "message": "<what to do>"}`, as for a missing trustline. The
  `PAYMENT-REQUIRED` header stays as upstream's, so every client reads it.
- **The catalog's answer.** `PaymentGate::on_event` reports each settlement with what the
  facilitator's `EXTENSION-RESPONSES` said: whether the Bazaar took the listing, and why not.

## Settings

| Call                                    | Meaning                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `Facilitator::with_api_key(key)`        | sent to `/verify` and `/settle` as `Authorization: Bearer`; pubnet will need one (0105)  |
| `Facilitator::with_timeout(duration)`   | the longest one call may take; 90 s unless set                                           |
| `PaymentGate::base_url(url)`            | the seller's public address; set it behind a proxy, else the `Host` header names the URL |
| `PaymentGate::on_event(observe)`        | settlements, the facilitator's refusals and its failures, for logs and metrics           |
| `Price::usdc("0.001")`                  | USDC as a decimal, read as text and never as a float; at most 7 decimals                 |
| `Price::token(contract, base_units)`    | any SEP-41 token, in its base units; zero is refused, as for USDC                        |
| `PaidRoute::listing(Listing::query(…))` | the `bazaar` block; `Listing::json_body` for POST, PUT and PATCH                         |

A mistyped `payTo` or token contract, and a network the facilitator does not settle on, stop the
seller at start.

## Without axum

```toml
stellar-x402 = { git = "https://github.com/rumblefishdev/stellar-x402", branch = "develop", default-features = false }
```

leaves axum out, and the parts are public for any other framework: `PaymentRequired` (the 402 and its header),
`PaymentPayload::from_header` and `accepts`, `Facilitator::{supported, verify, settle}` and
`SettleResponse::to_header`.

## Develop

```bash
cd packages/sdk/rust
cargo test && cargo test --no-default-features
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings && cargo clippy --all-targets --no-default-features -- -D warnings
```

The oldest supported Rust is 1.81, with the versions in `Cargo.lock`. Newer versions of several
dependencies (`idna_adapter`, `stellar-strkey` 1.0) need 1.82 to 1.87. A seller on 1.81 sets
`rust-version = "1.81"` in its own `Cargo.toml`, resolves its `Cargo.lock` with cargo 1.84 or
newer, which then picks versions that fit it:

```bash
CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo update
```

and builds with 1.81. Cargo 1.81 does not read that setting, and without `rust-version` the
resolver aims at the cargo it runs on.
