//! A facilitator on a local port that answers what a test tells it to and keeps what it was sent.
#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use stellar_x402::{Network, PaymentPayload, PaymentRequirements, Price, Supported};

pub const PAY_TO: &str = "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3";
pub const PAYER: &str = "GAZQTB6FZ6O7GPATG3OXCV5PPI3Y62RVF7GEKXF3P53VJPLKLBQSZFKG";
pub const HASH: &str = "6bd72a6ef6a77a7dc08e501bd4849b6c28ad88cceabb51a4fd105673949412a2";

pub fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Our testnet facilitator's `/supported`, as it answered on 2026-11-12.
pub fn supported() -> Supported {
    serde_json::from_value(fixture("supported.json")).unwrap()
}

/// 0.001 testnet USDC to `PAY_TO`, completed from `supported()`.
pub fn terms() -> PaymentRequirements {
    PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::usdc("0.001").unwrap())
        .unwrap()
        .with_supported(&supported())
}

/// A payment as a buyer's client sends it for `terms`: the terms echoed, and a signed transaction
/// that no test reads.
pub fn payment_json(terms: &PaymentRequirements) -> Value {
    json!({
        "x402Version": 2,
        "resource": { "url": "http://localhost/weather?city=Warsaw" },
        "accepted": terms,
        "payload": { "transaction": "AAAAAgAAAAA=" }
    })
}

pub fn header_of(value: &Value) -> String {
    STANDARD.encode(serde_json::to_vec(value).unwrap())
}

pub fn payment(terms: &PaymentRequirements) -> PaymentPayload {
    PaymentPayload::from_header(&header_of(&payment_json(terms))).unwrap()
}

/// One request the fake received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    pub authorization: Option<String>,
    pub body: Value,
}

/// What the fake answers on one route.
#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub body: String,
    pub extension_responses: Option<String>,
    pub delay: Duration,
}

impl Reply {
    pub fn json(status: u16, body: Value) -> Self {
        Self::text(status, &body.to_string())
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_owned(),
            extension_responses: None,
            delay: Duration::ZERO,
        }
    }

    /// Adds the `EXTENSION-RESPONSES` header: `value` as base64 JSON.
    pub fn extension_responses(mut self, value: Value) -> Self {
        self.extension_responses = Some(header_of(&value));
        self
    }

    pub fn after(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

#[derive(Clone)]
struct Replies {
    supported: Reply,
    verify: Reply,
    settle: Reply,
    /// Answers to the next `/settle` calls, one each, before `settle` answers again.
    settle_once: VecDeque<Reply>,
}

#[derive(Clone)]
pub struct FakeFacilitator {
    pub url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    replies: Arc<Mutex<Replies>>,
}

impl FakeFacilitator {
    /// Starts with a facilitator that accepts and settles every payment.
    pub async fn start() -> Self {
        let replies = Replies {
            supported: Reply::json(200, fixture("supported.json")),
            verify: Reply::json(200, json!({ "isValid": true, "payer": PAYER })),
            settle: Reply::json(
                200,
                json!({
                    "success": true,
                    "payer": PAYER,
                    "transaction": HASH,
                    "network": "stellar:testnet"
                }),
            ),
            settle_once: VecDeque::new(),
        };
        let fake = Self {
            url: String::new(),
            seen: Arc::default(),
            replies: Arc::new(Mutex::new(replies)),
        };
        let app = Router::new()
            .route("/supported", get(answer))
            .route("/verify", post(answer))
            .route("/settle", post(answer))
            .with_state(fake.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, ..fake }
    }

    pub fn supported_replies(&self, reply: Reply) {
        self.replies.lock().unwrap().supported = reply;
    }

    pub fn verify_replies(&self, reply: Reply) {
        self.replies.lock().unwrap().verify = reply;
    }

    pub fn settle_replies(&self, reply: Reply) {
        self.replies.lock().unwrap().settle = reply;
    }

    /// Answers the next `/settle` with `reply`, and the ones after it as before.
    pub fn settle_replies_once(&self, reply: Reply) {
        self.replies.lock().unwrap().settle_once.push_back(reply);
    }

    /// Every request so far, in order.
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The paths requested so far, in order.
    pub fn paths(&self) -> Vec<String> {
        self.seen().into_iter().map(|seen| seen.path).collect()
    }
}

async fn answer(
    State(fake): State<FakeFacilitator>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = uri.path().to_owned();
    fake.seen.lock().unwrap().push(Seen {
        path: path.clone(),
        authorization: headers
            .get("authorization")
            .map(|value| value.to_str().unwrap().to_owned()),
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    });
    let reply = {
        let mut replies = fake.replies.lock().unwrap();
        match path.as_str() {
            "/supported" => replies.supported.clone(),
            "/verify" => replies.verify.clone(),
            _ => match replies.settle_once.pop_front() {
                Some(once) => once,
                None => replies.settle.clone(),
            },
        }
    };
    tokio::time::sleep(reply.delay).await;
    let mut response = (StatusCode::from_u16(reply.status).unwrap(), reply.body).into_response();
    if let Some(value) = reply.extension_responses {
        response
            .headers_mut()
            .insert("EXTENSION-RESPONSES", value.parse().unwrap());
    }
    response
}
