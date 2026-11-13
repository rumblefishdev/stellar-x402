//! The client of a facilitator's three routes: `/supported`, `/verify` and `/settle`.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::{PaymentPayload, PaymentRequirements, Supported};

/// Upstream's default: the longest one call to the facilitator may take.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(90);
const EXTENSION_RESPONSES: &str = "EXTENSION-RESPONSES";
/// How much of an unexpected answer an error keeps.
const EXCERPT_CHARS: usize = 200;
/// The reason a payment the facilitator could not read is refused with.
const INVALID_PAYLOAD: &str = "invalid_payload";

/// A facilitator: the service that checks a buyer's payment and settles it on Stellar.
#[derive(Clone)]
pub struct Facilitator {
    url: String,
    http: reqwest::Client,
    api_key: Option<String>,
    timeout: Duration,
}

/// Says whether an API key is set, never the key: debug output ends up in logs.
impl std::fmt::Debug for Facilitator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Facilitator")
            .field("url", &self.url)
            .field("api_key", &self.api_key.as_ref().map(|_| "set"))
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

/// Why a call to the facilitator gave no answer to act on.
///
/// A refused payment is not one of these: it comes back as a [`VerifyResponse`] or a
/// [`SettleResponse`] that says why.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum FacilitatorError {
    #[error("{url} is not an http(s) URL")]
    Url { url: String },
    #[error("the HTTP client could not be made: {0}")]
    Client(#[source] reqwest::Error),
    #[error("the facilitator could not be reached on {route}: {source}")]
    Unreachable {
        route: &'static str,
        #[source]
        source: reqwest::Error,
    },
    #[error("the facilitator did not answer {route} in time")]
    Timeout { route: &'static str },
    #[error("the facilitator answered {status} on {route}: {}", code.as_deref().unwrap_or(body))]
    Status {
        status: u16,
        route: &'static str,
        /// The facilitator's `error` code, when its answer has one.
        code: Option<String>,
        /// The start of the answer's body.
        body: String,
    },
    #[error("the facilitator's answer on {route} is not what the route returns: {body}")]
    Body { route: &'static str, body: String },
}

/// What `/verify` answers.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResponse {
    pub is_valid: bool,
    /// The code of the refusal, such as `invalid_exact_stellar_payer_trustline_missing`.
    #[serde(default)]
    pub invalid_reason: Option<String>,
    /// The refusal in words, with what to do about it, when the facilitator says.
    #[serde(default)]
    pub invalid_message: Option<String>,
    #[serde(default)]
    pub payer: Option<String>,
    /// What the facilitator's extensions answered, from its `EXTENSION-RESPONSES` header.
    #[serde(skip)]
    pub extension_responses: Option<Map<String, Value>>,
}

/// What `/settle` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleResponse {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payer: Option<String>,
    /// The hash of the settlement's transaction; empty when nothing was sent.
    #[serde(default)]
    pub transaction: String,
    #[serde(default)]
    pub network: String,
    /// Fields this crate does not read, kept so the buyer gets them.
    #[serde(flatten)]
    pub other: Map<String, Value>,
    /// What the facilitator's extensions answered, from its `EXTENSION-RESPONSES` header: for
    /// `bazaar`, whether the listing was cataloged. For the seller, never sent to the buyer.
    #[serde(skip)]
    pub extension_responses: Option<Map<String, Value>>,
}

impl SettleResponse {
    /// The value of the `PAYMENT-RESPONSE` header: this answer as JSON, in base64.
    pub fn to_header(&self) -> String {
        let json = serde_json::to_vec(self).expect("the answer is JSON the facilitator sent");
        STANDARD.encode(json)
    }
}

impl Facilitator {
    /// A client of the facilitator at `url`, such as `https://x402-facilitator.sorobanscan.com`.
    pub fn new(url: &str) -> Result<Self, FacilitatorError> {
        let is_http = reqwest::Url::parse(url)
            .is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"));
        if !is_http {
            return Err(FacilitatorError::Url {
                url: url.to_owned(),
            });
        }
        // A redirect is answered as it is, never followed: a 307 or 308 would send the buyer's
        // signed payment to another address, and a 301 turns the POST into a GET.
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(FacilitatorError::Client)?;
        Ok(Self {
            url: url.trim_end_matches('/').to_owned(),
            http,
            api_key: None,
            timeout: DEFAULT_TIMEOUT,
        })
    }

    /// Sends `key` to `/verify` and `/settle` as `Authorization: Bearer`. `/supported` is open and
    /// gets no key.
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// The longest one call may take; 90 seconds unless set.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The schemes and networks the facilitator verifies and settles.
    pub async fn supported(&self) -> Result<Supported, FacilitatorError> {
        let route = "/supported";
        let request = self.http.get(format!("{}{route}", self.url));
        let answer = self.send(route, request).await?;
        if !answer.ok {
            return Err(answer.status_error(route));
        }
        serde_json::from_value(answer.json.clone()).map_err(|_| answer.body_error(route))
    }

    /// Asks whether `payment` pays `terms`. Nothing is sent to the network.
    ///
    /// A 400 without a verdict is a refusal, `invalid_payload`, and not an error: the seller's
    /// terms passed its own checks, so what the facilitator could not read is the buyer's
    /// payment.
    pub async fn verify(
        &self,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> Result<VerifyResponse, FacilitatorError> {
        let route = "/verify";
        let answer = self.send(route, self.post(route, payment, terms)).await?;
        if answer.json.get("isValid").is_none() && answer.status == 400 {
            return Ok(VerifyResponse {
                is_valid: false,
                invalid_reason: Some(INVALID_PAYLOAD.to_owned()),
                invalid_message: None,
                payer: None,
                extension_responses: answer.extension_responses,
            });
        }
        if answer.json.get("isValid").is_none() && !answer.ok {
            return Err(answer.status_error(route));
        }
        let mut verified: VerifyResponse =
            serde_json::from_value(answer.json.clone()).map_err(|_| answer.body_error(route))?;
        verified.extension_responses = answer.extension_responses;
        Ok(verified)
    }

    /// Settles `payment` on Stellar: the transfer the buyer signed, its fee paid by the
    /// facilitator.
    pub async fn settle(
        &self,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> Result<SettleResponse, FacilitatorError> {
        let route = "/settle";
        let answer = self.send(route, self.post(route, payment, terms)).await?;
        if answer.json.get("success").is_none() && !answer.ok {
            return Err(answer.status_error(route));
        }
        let mut settled: SettleResponse =
            serde_json::from_value(answer.json.clone()).map_err(|_| answer.body_error(route))?;
        settled.extension_responses = answer.extension_responses;
        Ok(settled)
    }

    fn post(
        &self,
        route: &str,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> reqwest::RequestBuilder {
        let request = self.http.post(format!("{}{route}", self.url)).json(&json!({
            "x402Version": 2,
            "paymentPayload": payment,
            "paymentRequirements": terms,
        }));
        match &self.api_key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }

    async fn send(
        &self,
        route: &'static str,
        request: reqwest::RequestBuilder,
    ) -> Result<Answer, FacilitatorError> {
        let failed = |source: reqwest::Error| match source.is_timeout() {
            true => FacilitatorError::Timeout { route },
            false => FacilitatorError::Unreachable { route, source },
        };
        let response = request.timeout(self.timeout).send().await.map_err(failed)?;
        let status = response.status();
        let extension_responses = response
            .headers()
            .get(EXTENSION_RESPONSES)
            .and_then(|value| STANDARD.decode(value.as_bytes()).ok())
            .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok());
        let body = response.text().await.map_err(failed)?;
        Ok(Answer {
            ok: status.is_success(),
            status: status.as_u16(),
            json: serde_json::from_str(&body).unwrap_or(Value::Null),
            body,
            extension_responses,
        })
    }
}

/// One answer of the facilitator, read whole.
struct Answer {
    ok: bool,
    status: u16,
    /// The body as JSON, or null when it is not JSON.
    json: Value,
    body: String,
    extension_responses: Option<Map<String, Value>>,
}

impl Answer {
    fn excerpt(&self) -> String {
        let compact = self.body.split_whitespace().collect::<Vec<_>>().join(" ");
        match compact.char_indices().nth(EXCERPT_CHARS) {
            Some((end, _)) => format!("{}...", &compact[..end]),
            None => compact,
        }
    }

    fn status_error(&self, route: &'static str) -> FacilitatorError {
        FacilitatorError::Status {
            status: self.status,
            route,
            code: self
                .json
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned),
            body: self.excerpt(),
        }
    }

    fn body_error(&self, route: &'static str) -> FacilitatorError {
        FacilitatorError::Body {
            route,
            body: self.excerpt(),
        }
    }
}
