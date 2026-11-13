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

The same answer, for the same request and the same facilitator answer, as `@x402/express` 2.31.0
gives: status, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`, `Cache-Control` and body, its error
messages word for word. A 402 with an `error` repeats it in the body, `{"error": "…"}`.

| Request                                                                    | Answer                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No payment, or a `PAYMENT-SIGNATURE` nobody can read                       | 402, the terms in `PAYMENT-REQUIRED`, `error: "Payment required"`; a browser gets upstream's HTML page instead of the JSON body                                                             |
| A payment made for other terms                                             | 402, `error: "No matching payment requirements"`; the facilitator is not asked                                                                                                              |
| A payment the facilitator refuses, its verdict sent with 200               | 402, `error` is its reason code; its message goes to the seller's `on_event` only                                                                                                           |
| A facilitator answer with an error status (400, 401, 429, 503, …)          | 402, `error` is upstream's, e.g. `Facilitator verify failed (503): {"error":"rpc_unavailable"}`, or for a verdict sent with an error status `"<reason>: <message>"`; the route does not run |
| A facilitator answer over 1 MiB                                            | 402, `error: "http response body too large: limit 1048576 bytes"`; the route does not run                                                                                                   |
| A valid payment, and the route answers below 400                           | the route's answer, with `PAYMENT-RESPONSE` and the transaction's hash                                                                                                                      |
| A valid payment, and the route answers 400 or above                        | the route's answer; nothing is settled, so the buyer pays nothing                                                                                                                           |
| The route answered, and the facilitator won't settle or can't              | 402, an empty body, `PAYMENT-RESPONSE` with the reason (for an error status, upstream's message); the route's answer is not sent                                                            |
| The facilitator answers `settlement_pending` with a transaction hash       | `/settle` is asked once more, as upstream does, and that answer counts. A second `settlement_pending` is 402 while the transaction may still land: the buyer can pay and get nothing        |
| A facilitator answer that is not JSON, not what the route returns, or late | 502, `{"error": "Facilitator verify returned invalid JSON: …"}` or `… request timed out after 90000ms`                                                                                      |

The facilitator's answers are read as upstream's client reads them: at most 1 MiB (a longer one is
402, not 502), checked against its schemas, and a `PAYMENT-RESPONSE` with only the fields its
schema keeps. A redirect is
the one place the crate is stricter: it is not followed (upstream follows it), so it answers as an
error status.

A paid answer keeps the route's own `Cache-Control`, with `private` added, so a shared cache does
not keep it.

The payment is checked, the route runs and the payment is settled inside the request. A buyer who
disconnects ends all three where they are: during `/settle` the facilitator may still move the
money with no event to say so, and after the route ran its work is not paid for. Settling apart
from the request is part 2's.

The payment is settled once the route's answer has its status and headers, before its body is
sent. A streamed body that breaks halfway is still paid for: the buyer gets 200 and
`PAYMENT-RESPONSE`, then a body that ends early. Upstream's middleware holds the whole body before
it settles; holding it here is part 2's too.

The 402 is held equal to what `@x402/express` sends for the same route: a test compares the two
(`tests/fixtures/payment-required-upstream.json`, captured from 2.28.0; 2.31.0 sends the same).

What the seller gets that upstream's middleware does not pass on, through
`PaymentGate::on_event`: the facilitator's message with each refusal, its own code (`extra`, such
as our facilitator's `reason`), the cause of each failure, and the catalog's answer from
`EXTENSION-RESPONSES`: whether the Bazaar took the listing, and why not.

## Settings

| Call                                    | Meaning                                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Facilitator::with_api_key(key)`        | sent to `/verify` and `/settle` as `Authorization: Bearer`; pubnet will need one (0105)                                                                                                                                                          |
| `Facilitator::with_timeout(duration)`   | the longest one call may take; 90 s unless set. One paid request can make three calls, `/verify` and `/settle` twice after a `settlement_pending`: 270 s plus the route on the defaults, so size a proxy's timeout to that                       |
| `PaymentGate::base_url(url)`            | the seller's public address: the 402 and the catalog's listing name the resource by it. Without it the URL is `http://{Host}{path}`, wrong behind a proxy that ends TLS, and any buyer can choose the `Host`; a listed route behind TLS needs it |
| `PaymentGate::on_event(observe)`        | settlements, the facilitator's refusals and its failures, for logs and metrics                                                                                                                                                                   |
| `Price::usdc("0.001")`                  | USDC as a decimal, read as text and never as a float; at most 7 decimals                                                                                                                                                                         |
| `Price::token(contract, base_units)`    | any SEP-41 token, in its base units; zero is refused, as for USDC                                                                                                                                                                                |
| `PaidRoute::description(text)`          | what the route gives, in a sentence: the 402's `resource.description`, shown by the catalog                                                                                                                                                      |
| `PaidRoute::mime_type(type)`            | the media type of the route's answer: the 402's `resource.mimeType`                                                                                                                                                                              |
| `PaidRoute::listing(Listing::query(…))` | the `bazaar` block; `Listing::json_body` for POST, PUT and PATCH. The catalog lists the route at the 402's URL: see `base_url`                                                                                                                   |
| `Extension<Payer>` in a handler         | the account that paid, as `/verify` named it; the only way a handler learns who paid                                                                                                                                                             |

A mistyped `payTo` or token contract, and a network the facilitator does not settle on, stop the
seller at start.

## Without axum

```toml
stellar-x402 = { git = "https://github.com/rumblefishdev/stellar-x402", branch = "develop", default-features = false }
```

leaves axum out, and the parts are public for any other framework. The layer puts them together
in this order, and a seller on another framework does the same:

1. At start: `Facilitator::supported()`, then `PaymentRequirements::exact(network, pay_to, price)`,
   refused unless `supported.supports(&terms)`, then `.with_supported(&supported)`. Without that
   last call the terms lack `areFeesSponsored`, and upstream's client will not pay them.
2. A request without a readable `PAYMENT-SIGNATURE`: 402 with
   `PaymentRequired::new(ResourceInfo::new(url), vec![terms])` (and `.with_listing(…)` for the
   catalog) in `PAYMENT-REQUIRED` via `to_header()`, `Cache-Control: no-store`, and the body
   `{"error": "Payment required"}`.
3. A request with one: `PaymentPayload::from_header(…)`; a header that cannot be read is no
   payment, and a payment for which `accepts(&terms)` is false gets 402
   `No matching payment requirements`.
4. `Facilitator::verify(&payment, &terms)`: a payment that is not valid gets 402 with its
   `invalid_reason` in `error`.
5. The route runs. An answer of 400 or above goes to the buyer as it is: nothing is settled.
6. `Facilitator::settle(&payment, &terms)`: on success, the route's answer with `PAYMENT-RESPONSE`
   from `SettleResponse::to_header()` and `private` added to its `Cache-Control`; otherwise 402,
   an empty body, `PAYMENT-RESPONSE` and `Cache-Control: no-store`, and the route's answer is not
   sent.

The layer also words each failure of the facilitator as `@x402/express` does (the table above);
that wording is the layer's own today, and other frameworks get it in part 2.

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
