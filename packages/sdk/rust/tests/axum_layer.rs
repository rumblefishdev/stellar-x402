//! The axum layer in front of a route, with a seller and a facilitator on local ports and
//! reqwest as the buyer.
#![cfg(feature = "axum")]

mod support;

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Query;
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Extension, Json, Router};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use stellar_x402::axum::{GateError, Payer, PaymentEvent, PaymentGate};
use stellar_x402::{Facilitator, FacilitatorError, Listing, Network, Price};
use support::{header_of, FakeFacilitator, Reply, HASH, PAYER, PAY_TO};

/// A seller with one paid route, `GET /weather?city=`, that answers 400 without a city and 500
/// when asked to `fail`. The same route is nested under `/v1`.
struct Seller {
    url: String,
    /// How many times the route itself ran.
    served: Arc<AtomicUsize>,
    /// What the gate reported, one line per event.
    events: Arc<Mutex<Vec<String>>>,
    fake: FakeFacilitator,
}

async fn seller() -> Seller {
    seller_with(
        FakeFacilitator::start().await,
        Some("https://api.example.com"),
    )
    .await
}

async fn seller_with(fake: FakeFacilitator, base_url: Option<&str>) -> Seller {
    let facilitator = Facilitator::new(&fake.url).unwrap();
    seller_on(fake, base_url, facilitator).await
}

async fn seller_on(
    fake: FakeFacilitator,
    base_url: Option<&str>,
    facilitator: Facilitator,
) -> Seller {
    let served = Arc::new(AtomicUsize::new(0));
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = events.clone();
    let mut gate = PaymentGate::connect(facilitator)
        .await
        .unwrap()
        .on_event(move |event| {
            let line = match event {
                PaymentEvent::Settled(settled) => format!(
                    "settled {} bazaar={}",
                    settled.transaction,
                    settled
                        .extension_responses
                        .as_ref()
                        .and_then(|answers| answers.get("bazaar"))
                        .map_or("none".to_owned(), Value::to_string)
                ),
                PaymentEvent::SettleRefused(settled) => {
                    format!("settle refused {:?}", settled.error_reason)
                }
                PaymentEvent::VerifyRefused(verified) => {
                    format!("verify refused {:?}", verified.invalid_reason)
                }
                PaymentEvent::FacilitatorFailed(error) => format!("facilitator failed: {error}"),
                other => format!("{other:?}"),
            };
            seen.lock().unwrap().push(line);
        });
    if let Some(base_url) = base_url {
        gate = gate.base_url(base_url);
    }
    let paid = gate
        .charge(Network::Testnet, PAY_TO, Price::usdc("0.001").unwrap())
        .unwrap()
        .description("Current temperature for a city")
        .mime_type("application/json")
        .listing(
            Listing::query(json!({ "city": "Warsaw" }))
                .output(json!({ "city": "Warsaw", "tempC": 14 })),
        );
    let count = served.clone();
    let weather = move |Query(query): Query<HashMap<String, String>>,
                        payer: Option<Extension<Payer>>| async move {
        count.fetch_add(1, Ordering::SeqCst);
        if query.contains_key("fail") {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "the weather station is down" })),
            );
        }
        match query.get("city") {
            Some(city) => (
                StatusCode::OK,
                Json(json!({ "city": city, "tempC": 14, "payer": payer.map(|p| p.0 .0) })),
            ),
            None => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "city is required" })),
            ),
        }
    };
    let app = Router::new()
        .route("/weather", get(weather.clone()).route_layer(paid.clone()))
        .nest(
            "/v1",
            Router::new().route("/weather", get(weather).route_layer(paid)),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Seller {
        url,
        served,
        events,
        fake,
    }
}

fn decoded(response: &reqwest::Response, header: &str) -> Option<Value> {
    let value = response.headers().get(header)?;
    Some(serde_json::from_slice(&STANDARD.decode(value.as_bytes()).unwrap()).unwrap())
}

impl Seller {
    async fn get(&self, path: &str) -> reqwest::Response {
        reqwest::get(format!("{}{path}", self.url)).await.unwrap()
    }

    /// Asks for the terms, then pays them: the request again with `PAYMENT-SIGNATURE`.
    async fn pay(&self, path: &str) -> reqwest::Response {
        let terms =
            decoded(&self.get(path).await, "payment-required").unwrap()["accepts"][0].clone();
        self.pay_with(
            path,
            &json!({ "x402Version": 2, "accepted": terms, "payload": {} }),
        )
        .await
    }

    async fn pay_with(&self, path: &str, payment: &Value) -> reqwest::Response {
        reqwest::Client::new()
            .get(format!("{}{path}", self.url))
            .header("PAYMENT-SIGNATURE", header_of(payment))
            .send()
            .await
            .unwrap()
    }

    fn served(&self) -> usize {
        self.served.load(Ordering::SeqCst)
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    /// The facilitator routes asked since the gate read `/supported` at its start.
    fn asked(&self) -> Vec<String> {
        self.fake.paths().into_iter().skip(1).collect()
    }
}

#[tokio::test]
async fn a_request_without_a_payment_gets_the_terms_and_the_route_does_not_run() {
    let seller = seller().await;

    let response = seller.get("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let required = decoded(&response, "payment-required").unwrap();
    assert_eq!(required["x402Version"], 2);
    assert_eq!(required["error"], "Payment required");
    assert_eq!(
        required["resource"],
        json!({
            "url": "https://api.example.com/weather?city=Warsaw",
            "description": "Current temperature for a city",
            "mimeType": "application/json"
        })
    );
    assert_eq!(
        required["accepts"],
        json!([{
            "scheme": "exact",
            "network": "stellar:testnet",
            "amount": "10000",
            "asset": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            "payTo": PAY_TO,
            "maxTimeoutSeconds": 300,
            "extra": { "areFeesSponsored": true }
        }])
    );
    assert_eq!(
        required["extensions"]["bazaar"]["info"]["input"]["method"],
        "GET"
    );
    assert_eq!(response.json::<Value>().await.unwrap(), json!({}));
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.asked(), Vec::<String>::new());
}

#[tokio::test]
async fn without_a_base_url_the_resource_is_named_by_the_requests_host() {
    let seller = seller_with(FakeFacilitator::start().await, None).await;

    let response = seller.get("/weather?city=Warsaw").await;

    let required = decoded(&response, "payment-required").unwrap();
    assert_eq!(
        required["resource"]["url"],
        format!("{}/weather?city=Warsaw", seller.url)
    );
}

#[tokio::test]
async fn a_paid_request_is_verified_served_and_then_settled() {
    let seller = seller().await;

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        decoded(&response, "payment-response").unwrap(),
        json!({ "success": true, "payer": PAYER, "transaction": HASH, "network": "stellar:testnet" })
    );
    assert_eq!(response.headers()["cache-control"], "private");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "city": "Warsaw", "tempC": 14, "payer": PAYER })
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(seller.asked(), ["/verify", "/settle"]);
}

#[tokio::test]
async fn the_facilitator_gets_the_buyers_payment_and_the_sellers_own_terms() {
    let seller = seller().await;

    seller.pay("/weather?city=Warsaw").await;

    let sent = &seller.fake.seen()[1].body;
    assert_eq!(
        sent["paymentPayload"]["accepted"],
        sent["paymentRequirements"]
    );
    assert_eq!(sent["paymentRequirements"]["payTo"], PAY_TO);
    assert_eq!(sent["paymentRequirements"]["amount"], "10000");
}

#[tokio::test]
async fn a_route_that_answers_an_error_is_not_settled() {
    let seller = seller().await;

    let response = seller.pay("/weather").await;

    assert_eq!(response.status(), 400);
    assert!(response.headers().get("payment-response").is_none());
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "city is required" })
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(seller.asked(), ["/verify"]);
}

#[tokio::test]
async fn a_refused_payment_gets_the_facilitators_reason_and_its_message() {
    let seller = seller().await;
    seller.fake.verify_replies(Reply::json(
        200,
        json!({
            "isValid": false,
            "invalidReason": "invalid_exact_stellar_payer_trustline_missing",
            "invalidMessage": "The payer has no trustline to USDC. Add one, then pay again."
        }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let required = decoded(&response, "payment-required").unwrap();
    assert_eq!(
        required["error"],
        "invalid_exact_stellar_payer_trustline_missing"
    );
    assert_eq!(required["accepts"][0]["amount"], "10000");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "error": "invalid_exact_stellar_payer_trustline_missing",
            "message": "The payer has no trustline to USDC. Add one, then pay again."
        })
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.asked(), ["/verify"]);
    assert_eq!(
        seller.events(),
        [r#"verify refused Some("invalid_exact_stellar_payer_trustline_missing")"#]
    );
}

#[tokio::test]
async fn a_payment_for_other_terms_is_refused_without_asking_the_facilitator() {
    let seller = seller().await;
    let mut terms = decoded(
        &seller.get("/weather?city=Warsaw").await,
        "payment-required",
    )
    .unwrap()["accepts"][0]
        .clone();
    terms["amount"] = json!("1");

    let response = seller
        .pay_with(
            "/weather?city=Warsaw",
            &json!({ "x402Version": 2, "accepted": terms, "payload": {} }),
        )
        .await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "No matching payment requirements"
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.asked(), Vec::<String>::new());
}

#[tokio::test]
async fn a_payment_header_that_cannot_be_read_gets_the_terms_again() {
    let seller = seller().await;

    let response = reqwest::Client::new()
        .get(format!("{}/weather?city=Warsaw", seller.url))
        .header("PAYMENT-SIGNATURE", "not base64!")
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "Payment required"
    );
    assert_eq!(seller.served(), 0);
}

#[tokio::test]
async fn a_settlement_the_facilitator_refuses_gets_402_with_its_reason_and_not_the_answer() {
    let seller = seller().await;
    seller.fake.settle_replies(Reply::json(
        200,
        json!({
            "success": false,
            "errorReason": "spend_budget_exhausted",
            "errorMessage": "This payer's fee budget is used up for today.",
            "payer": PAYER,
            "transaction": "",
            "network": "stellar:testnet"
        }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let settlement = decoded(&response, "payment-response").unwrap();
    assert_eq!(settlement["success"], false);
    assert_eq!(settlement["errorReason"], "spend_budget_exhausted");
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "error": "spend_budget_exhausted",
            "message": "This payer's fee budget is used up for today."
        })
    );
    assert_eq!(
        seller.events(),
        [r#"settle refused Some("spend_budget_exhausted")"#]
    );
}

#[tokio::test]
async fn a_facilitator_that_fails_at_verify_gets_502_and_the_route_does_not_run() {
    let seller = seller().await;
    seller
        .fake
        .verify_replies(Reply::json(401, json!({ "error": "invalid_api_key" })));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 502);
    let body = response.json::<Value>().await.unwrap();
    assert_eq!(body["error"], "facilitator_unavailable");
    // The seller's own trouble, an API key here, is for the seller and not the buyer.
    assert!(!body.to_string().contains("invalid_api_key"));
    assert_eq!(seller.served(), 0);
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator answered 401 on /verify: invalid_api_key"]
    );
}

#[tokio::test]
async fn a_facilitator_that_fails_at_settle_gets_502() {
    let seller = seller().await;
    seller.fake.settle_replies(Reply::text(500, "boom"));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 502);
    assert_eq!(
        response.json::<Value>().await.unwrap()["error"],
        "facilitator_unavailable"
    );
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator answered 500 on /settle: boom"]
    );
}

#[tokio::test]
async fn the_seller_is_told_whether_the_catalog_took_its_listing() {
    let seller = seller().await;
    seller.fake.settle_replies(
        Reply::json(
            200,
            json!({ "success": true, "payer": PAYER, "transaction": HASH, "network": "stellar:testnet" }),
        )
        .extension_responses(json!({ "bazaar": { "status": "rejected", "reason": "resource_not_public" } })),
    );

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(
        seller.events(),
        [format!(
            r#"settled {HASH} bazaar={{"reason":"resource_not_public","status":"rejected"}}"#
        )]
    );
    // The catalog's answer is the seller's: the buyer's header does not carry it.
    assert_eq!(
        decoded(&response, "payment-response")
            .unwrap()
            .get("extensionResponses"),
        None
    );
    assert!(response.headers().get("extension-responses").is_none());
}

#[tokio::test]
async fn the_gate_does_not_start_when_the_facilitator_cannot_be_reached() {
    let error = PaymentGate::connect(Facilitator::new("http://127.0.0.1:1").unwrap()).await;

    assert!(matches!(error, Err(GateError::Facilitator(_))));
}

#[tokio::test]
async fn a_route_on_a_network_the_facilitator_does_not_support_is_refused_at_start() {
    // The fake supports testnet only.
    let fake = FakeFacilitator::start().await;
    let gate = PaymentGate::connect(Facilitator::new(&fake.url).unwrap())
        .await
        .unwrap();

    let error = gate
        .charge(Network::Pubnet, PAY_TO, Price::usdc("0.001").unwrap())
        .err();

    assert!(
        matches!(
            error,
            Some(GateError::Unsupported {
                network: Network::Pubnet
            })
        ),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_mistyped_account_is_refused_at_start() {
    let fake = FakeFacilitator::start().await;
    let gate = PaymentGate::connect(Facilitator::new(&fake.url).unwrap())
        .await
        .unwrap();

    let error = gate
        .charge(Network::Testnet, "GABC", Price::usdc("0.001").unwrap())
        .err();

    assert!(matches!(error, Some(GateError::Address(_))), "{error:?}");
}

#[tokio::test]
async fn a_method_the_route_does_not_have_gets_405_and_no_terms() {
    let seller = seller().await;
    let client = reqwest::Client::new();
    let terms = decoded(
        &seller.get("/weather?city=Warsaw").await,
        "payment-required",
    )
    .unwrap()["accepts"][0]
        .clone();
    let payment = json!({ "x402Version": 2, "accepted": terms, "payload": {} });

    let options = client
        .request(
            reqwest::Method::OPTIONS,
            format!("{}/weather?city=Warsaw", seller.url),
        )
        .send()
        .await
        .unwrap();
    let paid_post = client
        .post(format!("{}/weather?city=Warsaw", seller.url))
        .header("PAYMENT-SIGNATURE", header_of(&payment))
        .send()
        .await
        .unwrap();

    for response in [options, paid_post] {
        assert_eq!(response.status(), 405);
        assert!(response.headers().get("payment-required").is_none());
    }
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.asked(), Vec::<String>::new());
}

#[tokio::test]
async fn a_route_that_fails_is_not_settled() {
    let seller = seller().await;

    let response = seller.pay("/weather?city=Warsaw&fail").await;

    assert_eq!(response.status(), 500);
    assert!(response.headers().get("payment-response").is_none());
    assert_eq!(seller.served(), 1);
    assert_eq!(seller.asked(), ["/verify"]);
}

#[tokio::test]
async fn a_payment_the_facilitator_cannot_read_is_refused_and_not_a_facilitator_failure() {
    let seller = seller().await;
    // What our facilitator answers a payload that fails its schema.
    seller
        .fake
        .verify_replies(Reply::json(400, json!({ "error": "bad_request" })));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "invalid_payload"
    );
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "invalid_payload" })
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(
        seller.events(),
        [r#"verify refused Some("invalid_payload")"#]
    );
}

#[tokio::test]
async fn a_routes_own_cache_control_is_kept_and_made_private() {
    let fake = FakeFacilitator::start().await;
    let gate = PaymentGate::connect(Facilitator::new(&fake.url).unwrap())
        .await
        .unwrap();
    let paid = gate
        .charge(Network::Testnet, PAY_TO, Price::usdc("0.001").unwrap())
        .unwrap();
    let cached = |value: &'static str| {
        get(move || async move { ([("cache-control", value)], "14 °C") }).route_layer(paid.clone())
    };
    let app = Router::new()
        .route("/public", cached("public, max-age=60"))
        .route("/private", cached("Private, max-age=60"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let seller = Seller {
        url,
        served: Arc::default(),
        events: Arc::default(),
        fake,
    };

    let public = seller.pay("/public").await;
    let private = seller.pay("/private").await;

    assert_eq!(public.status(), 200);
    assert_eq!(
        public.headers()["cache-control"],
        "public, max-age=60, private"
    );
    assert_eq!(private.headers()["cache-control"], "Private, max-age=60");
}

#[tokio::test]
async fn the_gate_does_not_start_when_the_facilitator_fails_on_supported() {
    let fake = FakeFacilitator::start().await;
    fake.supported_replies(Reply::text(503, "starting"));

    let error = PaymentGate::connect(Facilitator::new(&fake.url).unwrap()).await;

    assert!(
        matches!(
            error,
            Err(GateError::Facilitator(FacilitatorError::Status {
                status: 503,
                ..
            }))
        ),
        "{:?}",
        error.err()
    );
}

#[tokio::test]
async fn fields_of_the_settlement_this_crate_does_not_read_reach_the_buyer() {
    let seller = seller().await;
    seller.fake.settle_replies(Reply::json(
        200,
        json!({
            "success": true,
            "payer": PAYER,
            "transaction": HASH,
            "network": "stellar:testnet",
            "amount": "10000"
        }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(
        decoded(&response, "payment-response").unwrap()["amount"],
        "10000"
    );
}

#[tokio::test]
async fn a_nested_route_is_named_by_its_full_path() {
    let seller = seller().await;

    let response = seller.get("/v1/weather?city=Warsaw").await;

    assert_eq!(
        decoded(&response, "payment-required").unwrap()["resource"]["url"],
        "https://api.example.com/v1/weather?city=Warsaw"
    );
}

#[tokio::test]
async fn a_trailing_slash_in_the_base_url_is_dropped() {
    let seller = seller_with(
        FakeFacilitator::start().await,
        Some("https://api.example.com/"),
    )
    .await;

    let response = seller.get("/weather?city=Warsaw").await;

    assert_eq!(
        decoded(&response, "payment-required").unwrap()["resource"]["url"],
        "https://api.example.com/weather?city=Warsaw"
    );
}

#[tokio::test]
async fn a_settlement_that_does_not_answer_in_time_gets_502_and_may_still_settle() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(200, json!({})).after(Duration::from_secs(5)));
    let facilitator = Facilitator::new(&fake.url)
        .unwrap()
        .with_timeout(Duration::from_millis(200));
    let seller = seller_on(fake, Some("https://api.example.com"), facilitator).await;

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 502);
    assert!(response.headers().get("payment-response").is_none());
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "error": "facilitator_unavailable",
            "message": "The payment could not be settled. It may still settle: check before paying again."
        })
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator did not answer /settle in time"]
    );
}
