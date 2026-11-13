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
    // `@x402/core` 2.31: a 402 with an `error` repeats it in the body.
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "Payment required" })
    );
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
async fn a_refused_payment_gets_the_facilitators_reason_and_not_its_message() {
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
    // As upstream's middleware: the reason in the body too, the message only in the seller's
    // event.
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "invalid_exact_stellar_payer_trustline_missing" })
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
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "No matching payment requirements" })
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
        settlement["errorMessage"],
        "This payer's fee budget is used up for today."
    );
    assert_eq!(response.json::<Value>().await.unwrap(), json!({}));
    assert_eq!(
        seller.events(),
        [r#"settle refused Some("spend_budget_exhausted")"#]
    );
}

#[tokio::test]
async fn a_facilitator_that_fails_at_verify_gets_402_with_upstreams_error() {
    let seller = seller().await;
    seller
        .fake
        .verify_replies(Reply::json(401, json!({ "error": "invalid_api_key" })));

    let response = seller.pay("/weather?city=Warsaw").await;

    // What `@x402/express` answers: 402, the facilitator's answer in `error`, an empty body.
    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        r#"Facilitator verify failed (401): {"error":"invalid_api_key"}"#
    );
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": r#"Facilitator verify failed (401): {"error":"invalid_api_key"}"# })
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator answered 401 on /verify: invalid_api_key"]
    );
}

#[tokio::test]
async fn a_facilitator_that_fails_at_settle_gets_402_with_upstreams_failed_settlement() {
    let seller = seller().await;
    seller.fake.settle_replies(Reply::text(500, "boom"));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        decoded(&response, "payment-response").unwrap(),
        json!({
            "success": false,
            "errorReason": "Facilitator settle failed (500): boom",
            "errorMessage": "Facilitator settle failed (500): boom",
            "network": "stellar:testnet",
            "transaction": ""
        })
    );
    assert_eq!(response.json::<Value>().await.unwrap(), json!({}));
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator answered 500 on /settle: boom"]
    );
}

#[tokio::test]
async fn a_facilitator_answer_that_is_not_json_gets_502_with_upstreams_error() {
    let seller = seller().await;
    seller.fake.verify_replies(Reply::text(200, "not json"));

    let response = seller.pay("/weather?city=Warsaw").await;

    // Upstream's `FacilitatorResponseError`: 502 and its message, no terms, no `Cache-Control`.
    assert_eq!(response.status(), 502);
    assert!(response.headers().get("payment-required").is_none());
    assert!(response.headers().get("cache-control").is_none());
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "Facilitator verify returned invalid JSON: not json" })
    );
    assert_eq!(seller.served(), 0);
}

#[tokio::test]
async fn a_verdict_with_an_error_status_never_lets_the_route_run() {
    let seller = seller().await;
    seller
        .fake
        .verify_replies(Reply::json(500, json!({ "isValid": true, "payer": PAYER })));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "unknown reason"
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.asked(), ["/verify"]);
}

#[tokio::test]
async fn a_refusal_without_a_reason_leaves_error_out_of_the_terms() {
    let seller = seller().await;
    seller
        .fake
        .verify_replies(Reply::json(200, json!({ "isValid": false })));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    let required = decoded(&response, "payment-required").unwrap();
    assert_eq!(required.get("error"), None);
}

/// A facilitator on a local port that answers `/supported`, finds every payment valid on
/// `/verify`, and closes the connection without an answer on `route`.
async fn facilitator_that_hangs_up_on(route: &'static str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let supported = support::fixture("supported.json").to_string();
    let valid = json!({ "isValid": true, "payer": PAYER }).to_string();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 65_536];
            let read = socket.read(&mut request).await.unwrap();
            let head = String::from_utf8_lossy(&request[..read]).into_owned();
            let path = head.split(' ').nth(1).unwrap_or_default().to_owned();
            let body = match path.as_str() {
                path if path == route => continue,
                "/supported" => &supported,
                _ => &valid,
            };
            let answer = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(answer.as_bytes()).await.unwrap();
        }
    });
    url
}

#[tokio::test]
async fn a_facilitator_that_hangs_up_at_verify_gets_402_as_a_failed_fetch_does_upstream() {
    let url = facilitator_that_hangs_up_on("/verify").await;
    let fake = FakeFacilitator::start().await;
    let seller = seller_on(
        fake,
        Some("https://api.example.com"),
        Facilitator::new(&url).unwrap(),
    )
    .await;

    let response = seller.pay("/weather?city=Warsaw").await;

    // Node's `fetch` throws "fetch failed", and upstream's middleware puts it in the 402.
    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "fetch failed"
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(seller.events().len(), 1);
    assert!(seller.events()[0]
        .starts_with("facilitator failed: the facilitator could not be reached on /verify"));
}

#[tokio::test]
async fn a_facilitator_that_hangs_up_at_settle_gets_402_with_a_failed_fetch_settlement() {
    let url = facilitator_that_hangs_up_on("/settle").await;
    let fake = FakeFacilitator::start().await;
    let seller = seller_on(
        fake,
        Some("https://api.example.com"),
        Facilitator::new(&url).unwrap(),
    )
    .await;

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-response").unwrap(),
        json!({
            "success": false,
            "errorReason": "fetch failed",
            "errorMessage": "fetch failed",
            "network": "stellar:testnet",
            "transaction": ""
        })
    );
    assert_eq!(seller.served(), 1);
}

#[tokio::test]
async fn our_facilitators_failures_at_verify_get_402_with_upstreams_error() {
    // `apps/facilitator`: the rate limit (429), an RPC with no verdict (503), a thrown error (500).
    for (status, code) in [
        (429, "too_many_requests"),
        (503, "rpc_unavailable"),
        (500, "internal_error"),
    ] {
        let seller = seller().await;
        seller
            .fake
            .verify_replies(Reply::json(status, json!({ "error": code })));

        let response = seller.pay("/weather?city=Warsaw").await;

        let error = format!(r#"Facilitator verify failed ({status}): {{"error":"{code}"}}"#);
        assert_eq!(response.status(), 402, "{code}");
        assert_eq!(
            decoded(&response, "payment-required").unwrap()["error"],
            error.as_str()
        );
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": error })
        );
        assert_eq!(seller.served(), 0, "{code}");
        assert_eq!(
            seller.events(),
            [format!(
                "facilitator failed: the facilitator answered {status} on /verify: {code}"
            )]
        );
    }
}

#[tokio::test]
async fn our_facilitators_failures_at_settle_get_402_with_a_failed_settlement() {
    // `apps/facilitator`: a process without the lease or shutting down (503, nothing sent), the
    // rate limit (429), a thrown error such as the store down (500). None is asked again.
    for (status, code) in [
        (503, "no_lease"),
        (503, "shutting_down"),
        (429, "too_many_requests"),
        (500, "internal_error"),
    ] {
        let seller = seller().await;
        seller
            .fake
            .settle_replies(Reply::json(status, json!({ "error": code })));

        let response = seller.pay("/weather?city=Warsaw").await;

        let error = format!(r#"Facilitator settle failed ({status}): {{"error":"{code}"}}"#);
        assert_eq!(response.status(), 402, "{code}");
        assert_eq!(response.headers()["cache-control"], "no-store");
        assert_eq!(
            decoded(&response, "payment-response").unwrap(),
            json!({
                "success": false,
                "errorReason": error,
                "errorMessage": error,
                "network": "stellar:testnet",
                "transaction": ""
            })
        );
        assert_eq!(response.json::<Value>().await.unwrap(), json!({}));
        assert_eq!(seller.asked(), ["/verify", "/settle"], "{code}");
    }
}

#[tokio::test]
async fn a_payment_already_settled_gets_402_with_the_facilitators_settlement() {
    // Our facilitator answers a success once (AD-6); the same payment again gets this, with the
    // hash of the transaction that paid.
    let seller = seller().await;
    let already = json!({
        "success": false,
        "errorReason": "settle_exact_stellar_already_settled",
        "errorMessage": "This payment was already answered.",
        "payer": PAYER,
        "transaction": HASH,
        "network": "stellar:testnet"
    });
    seller
        .fake
        .settle_replies(Reply::json(200, already.clone()));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(decoded(&response, "payment-response").unwrap(), already);
    assert_eq!(response.json::<Value>().await.unwrap(), json!({}));
    assert_eq!(seller.asked(), ["/verify", "/settle"]);
    assert_eq!(
        seller.events(),
        [r#"settle refused Some("settle_exact_stellar_already_settled")"#]
    );
}

#[tokio::test]
async fn a_facilitator_answer_over_one_mebibyte_gets_402_as_upstream_cuts_it() {
    let seller = seller().await;
    seller.fake.verify_replies(Reply::json(
        200,
        json!({ "isValid": true, "payer": PAYER, "pad": "x".repeat(1_100_000) }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "http response body too large: limit 1048576 bytes"
    );
    assert_eq!(seller.served(), 0);
}

#[tokio::test]
async fn a_settlement_missing_what_upstreams_schema_needs_gets_502() {
    let seller = seller().await;
    // As text: upstream quotes the answer as it came, in its own key order.
    seller.fake.settle_replies(Reply::text(
        200,
        r#"{"success":true,"network":"stellar:testnet"}"#,
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 502);
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({
            "error": r#"Facilitator settle returned invalid data: {"success":true,"network":"stellar:testnet"}"#
        })
    );
}

#[tokio::test]
async fn a_browser_without_a_payment_gets_upstreams_page() {
    let seller = seller().await;

    let response = reqwest::Client::new()
        .get(format!("{}/weather?city=Warsaw", seller.url))
        .header("accept", "text/html,application/xhtml+xml")
        .header("user-agent", "Mozilla/5.0")
        .send()
        .await
        .unwrap();

    // `@x402/core`'s fallback page: Stellar has no in-browser paywall upstream.
    assert_eq!(response.status(), 402);
    assert_eq!(response.headers()["content-type"], "text/html");
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        "Payment required"
    );
    let page = response.text().await.unwrap();
    assert!(page.starts_with("<!DOCTYPE html>"), "{page}");
    assert!(page.contains("This resource is protected by the x402 payment protocol."));
}

#[tokio::test]
async fn a_request_with_one_sign_of_a_browser_but_not_both_gets_json() {
    // Upstream's `isWebBrowser` wants both: `Accept` with `text/html` and a `Mozilla` agent.
    let seller = seller().await;
    let url = format!("{}/weather?city=Warsaw", seller.url);
    let client = reqwest::Client::new();

    let html_from_a_script = client
        .get(&url)
        .header("accept", "text/html")
        .header("user-agent", "curl/8.5.0")
        .send()
        .await
        .unwrap();
    let json_from_a_browser = client
        .get(&url)
        .header("accept", "application/json")
        .header("user-agent", "Mozilla/5.0")
        .send()
        .await
        .unwrap();

    for response in [html_from_a_script, json_from_a_browser] {
        assert_eq!(response.status(), 402);
        assert_eq!(response.headers()["content-type"], "application/json");
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!({ "error": "Payment required" })
        );
    }
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
async fn a_head_request_is_paid_for_as_its_get_route_is() {
    // axum answers HEAD with the GET handler; `@x402/core` 2.31.0 charges for it the same way.
    let seller = seller().await;
    let url = format!("{}/weather?city=Warsaw", seller.url);
    let client = reqwest::Client::new();

    let unpaid = client.head(&url).send().await.unwrap();

    assert_eq!(unpaid.status(), 402);
    let required = decoded(&unpaid, "payment-required").unwrap();
    assert_eq!(required["error"], "Payment required");
    assert_eq!(
        required["extensions"]["bazaar"]["info"]["input"]["method"],
        "HEAD"
    );
    assert_eq!(seller.served(), 0);

    let payment = json!({ "x402Version": 2, "accepted": required["accepts"][0], "payload": {} });
    let paid = client
        .head(&url)
        .header("PAYMENT-SIGNATURE", header_of(&payment))
        .send()
        .await
        .unwrap();

    assert_eq!(paid.status(), 200);
    assert_eq!(
        decoded(&paid, "payment-response").unwrap()["transaction"],
        HASH
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(seller.asked(), ["/verify", "/settle"]);
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
        r#"Facilitator verify failed (400): {"error":"bad_request"}"#
    );
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": r#"Facilitator verify failed (400): {"error":"bad_request"}"# })
    );
    assert_eq!(seller.served(), 0);
    // A refusal for the seller: the buyer's payment, not the facilitator, is at fault.
    assert_eq!(
        seller.events(),
        [r#"verify refused Some("Facilitator verify failed (400): {\"error\":\"bad_request\"}")"#]
    );
}

#[tokio::test]
async fn a_payment_too_large_for_the_facilitator_is_refused_and_not_a_facilitator_failure() {
    let seller = seller().await;
    // What our facilitator answers a body over its limit, 64 KiB unless set.
    seller
        .fake
        .verify_replies(Reply::json(413, json!({ "error": "payload_too_large" })));
    let terms = decoded(
        &seller.get("/weather?city=Warsaw").await,
        "payment-required",
    )
    .unwrap()["accepts"][0]
        .clone();
    // The terms copied, so it gets past the gate, and a payload no real payment needs.
    let payment = json!({
        "x402Version": 2,
        "accepted": terms,
        "payload": { "transaction": "A".repeat(70_000) }
    });

    let response = seller.pay_with("/weather?city=Warsaw", &payment).await;

    assert_eq!(response.status(), 402);
    assert_eq!(
        decoded(&response, "payment-required").unwrap()["error"],
        r#"Facilitator verify failed (413): {"error":"payload_too_large"}"#
    );
    assert_eq!(seller.served(), 0);
    assert_eq!(
        seller.events(),
        [
            r#"verify refused Some("Facilitator verify failed (413): {\"error\":\"payload_too_large\"}")"#
        ]
    );
}

#[tokio::test]
async fn a_settlement_still_pending_is_asked_for_again_and_the_answer_served() {
    let seller = seller().await;
    // The facilitator's settle budget ran out after the transaction was sent; asked again, it
    // answers how the transaction ended.
    seller.fake.settle_replies_once(Reply::json(
        200,
        json!({
            "success": false,
            "errorReason": "settlement_pending",
            "payer": PAYER,
            "transaction": HASH,
            "network": "stellar:testnet"
        }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(response.status(), 200);
    assert_eq!(
        decoded(&response, "payment-response").unwrap()["success"],
        true
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(seller.asked(), ["/verify", "/settle", "/settle"]);
    assert_eq!(seller.events(), [format!("settled {HASH} bazaar=none")]);
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
async fn the_buyer_gets_the_settlement_fields_upstreams_schema_has_and_no_others() {
    let seller = seller().await;
    seller.fake.settle_replies(Reply::json(
        200,
        json!({
            "success": true,
            "payer": PAYER,
            "transaction": HASH,
            "network": "stellar:testnet",
            "amount": "10000",
            "extensionResponses": { "bazaar": { "status": "rejected" } }
        }),
    ));

    let response = seller.pay("/weather?city=Warsaw").await;

    assert_eq!(
        decoded(&response, "payment-response").unwrap(),
        json!({
            "success": true,
            "payer": PAYER,
            "transaction": HASH,
            "network": "stellar:testnet",
            "amount": "10000"
        })
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
async fn a_settlement_that_does_not_answer_in_time_gets_502_with_upstreams_error() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(200, json!({})).after(Duration::from_secs(5)));
    let facilitator = Facilitator::new(&fake.url)
        .unwrap()
        .with_timeout(Duration::from_millis(200));
    let seller = seller_on(fake, Some("https://api.example.com"), facilitator).await;

    let response = seller.pay("/weather?city=Warsaw").await;

    // Upstream's `FacilitatorTimeoutError`, a `FacilitatorResponseError`: 502 and its message.
    assert_eq!(response.status(), 502);
    assert!(response.headers().get("payment-response").is_none());
    assert_eq!(
        response.json::<Value>().await.unwrap(),
        json!({ "error": "Facilitator settle request timed out after 200ms" })
    );
    assert_eq!(seller.served(), 1);
    assert_eq!(
        seller.events(),
        ["facilitator failed: the facilitator did not answer /settle in time"]
    );
}
