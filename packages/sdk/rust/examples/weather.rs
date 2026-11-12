//! A paid weather API on Stellar testnet, the Rust twin of `examples/http-api`.
//!
//! `GET /weather?city=Warsaw` costs 0.001 testnet USDC and is described for the Bazaar. It
//! answers a fixed temperature: the example shows the payment, not a weather service. A request
//! without `city` gets 400 and is not charged.
//!
//! ```bash
//! SELLER_ADDRESS=G... cargo run --example weather
//! curl -i "http://localhost:4020/weather?city=Warsaw"   # 402 with the PAYMENT-REQUIRED header
//! ```
//!
//! | Variable          | Default                                    | Meaning                                                    |
//! | ----------------- | ------------------------------------------ | ---------------------------------------------------------- |
//! | `SELLER_ADDRESS`  | required                                   | testnet account that is paid; it needs a USDC trustline    |
//! | `FACILITATOR_URL` | `https://x402-facilitator.sorobanscan.com` | facilitator that verifies and settles                      |
//! | `X402_API_KEY`    | none                                       | sent to the facilitator as a bearer token                  |
//! | `PUBLIC_URL`      | none                                       | the seller's public address, when it is behind a proxy     |
//! | `PORT`            | `4020`                                     | port to listen on                                          |

use std::collections::HashMap;
use std::env;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde_json::{json, Value};
use stellar_x402::axum::{PaymentEvent, PaymentGate};
use stellar_x402::{Facilitator, Listing, Network, Price};

const DEFAULT_FACILITATOR: &str = "https://x402-facilitator.sorobanscan.com";

async fn weather(Query(query): Query<HashMap<String, String>>) -> (StatusCode, Json<Value>) {
    // The payment is verified before this runs and settled only after it answers; an error
    // status cancels the settlement, so a request without a city costs nothing.
    match query.get("city").filter(|city| !city.is_empty()) {
        Some(city) => (StatusCode::OK, Json(json!({ "city": city, "tempC": 14 }))),
        None => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "city is required" })),
        ),
    }
}

fn report(event: &PaymentEvent<'_>) {
    match event {
        PaymentEvent::Settled(settled) => {
            let catalog = settled
                .extension_responses
                .as_ref()
                .and_then(|all| all.get("bazaar"));
            eprintln!(
                "settled {} from {}; catalog: {}",
                settled.transaction,
                settled.payer.as_deref().unwrap_or("?"),
                catalog.map_or("no answer".to_owned(), Value::to_string)
            );
        }
        PaymentEvent::SettleRefused(settled) => {
            eprintln!("settlement refused: {:?}", settled.error_reason)
        }
        PaymentEvent::VerifyRefused(verified) => {
            eprintln!("payment refused: {:?}", verified.invalid_reason)
        }
        PaymentEvent::FacilitatorFailed(error) => eprintln!("{error}"),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let seller = env::var("SELLER_ADDRESS").map_err(|_| "SELLER_ADDRESS is required")?;
    let url = env::var("FACILITATOR_URL").unwrap_or_else(|_| DEFAULT_FACILITATOR.to_owned());
    let port: u16 = match env::var("PORT") {
        Ok(port) => port.parse().map_err(|_| "PORT is not a port number")?,
        Err(_) => 4020,
    };

    let mut facilitator = Facilitator::new(&url)?;
    if let Ok(key) = env::var("X402_API_KEY") {
        facilitator = facilitator.with_api_key(key);
    }
    let mut gate = PaymentGate::connect(facilitator).await?.on_event(report);
    if let Ok(public_url) = env::var("PUBLIC_URL") {
        gate = gate.base_url(public_url);
    }
    let paid = gate
        .charge(Network::Testnet, seller.as_str(), Price::usdc("0.001")?)?
        .description("Current temperature for a city")
        .mime_type("application/json")
        .listing(
            Listing::query(json!({ "city": "Warsaw" }))
                .input_schema(json!({
                    "properties": { "city": { "type": "string" } },
                    "required": ["city"]
                }))
                .output(json!({ "city": "Warsaw", "tempC": 14 })),
        );

    let app = Router::new().route("/weather", get(weather).layer(paid));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    eprintln!("Paid weather API on http://localhost:{port}/weather?city=Warsaw, paying {seller}");
    axum::serve(listener, app).await?;
    Ok(())
}
