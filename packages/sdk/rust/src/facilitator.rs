//! The client of a facilitator's three routes: `/supported`, `/verify` and `/settle`.
//!
//! It reads the facilitator's answers as `@x402/core` 2.31.0's `HTTPFacilitatorClient` reads
//! them, so the axum layer can answer the buyer as `@x402/express` 2.31.0 does: the same
//! refusals and the same errors, word for word.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{PaymentPayload, PaymentRequirements, Supported};

/// Upstream's default: the longest one call to the facilitator may take.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(90);
const EXTENSION_RESPONSES: &str = "EXTENSION-RESPONSES";
/// Upstream's `MAX_CONTROL_PLANE_RESPONSE_BYTES`: the most of an answer that is read.
const MAX_ANSWER_BYTES: usize = 1 << 20;
/// Upstream's `responseExcerpt` limit, in UTF-16 units as JavaScript counts.
const EXCERPT_UNITS: usize = 200;
/// `@x402/core`'s reason for a settlement whose transaction was sent and is not final yet.
const SETTLEMENT_PENDING: &str = "settlement_pending";
/// What upstream's `VerifyError` and `SettleError` say when the facilitator gave no reason.
const UNKNOWN_REASON: &str = "unknown reason";
/// The message of Node's `fetch` for a request that got no answer, which upstream passes on.
const FETCH_FAILED: &str = "fetch failed";

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
/// [`SettleResponse`] that says why. `Display` is for the seller's logs; the buyer gets the
/// message `@x402/core`'s client throws for the same answer.
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
    Timeout {
        route: &'static str,
        /// The client's timeout.
        after: Duration,
    },
    #[error("the facilitator's answer on {route} is over {limit} bytes")]
    TooLarge { route: &'static str, limit: usize },
    #[error("the facilitator answered {status} on {route}: {}", code.as_deref().unwrap_or(body))]
    Status {
        status: u16,
        route: &'static str,
        /// The facilitator's `error` code, when its answer has one.
        code: Option<String>,
        /// The answer as upstream's `responseExcerpt` cuts it, at most 200 characters; JSON with
        /// the whitespace outside its strings removed (see `compact_json`).
        body: String,
    },
    #[error("the facilitator's answer on {route} is not JSON: {body}")]
    NotJson { route: &'static str, body: String },
    #[error("the facilitator's answer on {route} is not what the route returns: {body}")]
    InvalidData { route: &'static str, body: String },
}

impl FacilitatorError {
    /// The message of the error `@x402/core`'s client throws for the same answer, which
    /// `@x402/express` puts in the buyer's answer.
    pub(crate) fn upstream_message(&self) -> String {
        match self {
            Self::Url { .. } | Self::Client(_) => self.to_string(),
            Self::Unreachable { .. } => FETCH_FAILED.to_owned(),
            Self::Timeout { route, after } => format!(
                "Facilitator {} request timed out after {}ms",
                operation(route),
                after.as_millis()
            ),
            Self::TooLarge { limit, .. } => {
                format!("http response body too large: limit {limit} bytes")
            }
            Self::Status {
                status,
                route,
                body,
                ..
            } => format!("Facilitator {} failed ({status}): {body}", operation(route)),
            Self::NotJson { route, body } => {
                format!(
                    "Facilitator {} returned invalid JSON: {body}",
                    operation(route)
                )
            }
            Self::InvalidData { route, body } => {
                format!(
                    "Facilitator {} returned invalid data: {body}",
                    operation(route)
                )
            }
        }
    }

    /// Whether upstream throws this as a `FacilitatorResponseError`, which its middleware answers
    /// with 502. It answers every other error with 402.
    #[cfg(feature = "axum")]
    pub(crate) fn is_response_error(&self) -> bool {
        matches!(
            self,
            Self::Timeout { .. } | Self::NotJson { .. } | Self::InvalidData { .. }
        )
    }
}

/// `/verify` → `verify`, as upstream names the operation in its messages.
fn operation(route: &str) -> &str {
    route.trim_start_matches('/')
}

/// What `/verify` answers.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyResponse {
    pub is_valid: bool,
    /// The code of the refusal, such as `invalid_exact_stellar_payer_trustline_missing`. For an
    /// answer upstream's client turns into an error, that error's message, as the buyer gets it.
    #[serde(default)]
    pub invalid_reason: Option<String>,
    /// The refusal in words, with what to do about it, when the facilitator says.
    #[serde(default)]
    pub invalid_message: Option<String>,
    #[serde(default)]
    pub payer: Option<String>,
    /// What the facilitator adds to its verdict, such as our facilitator's own code in `reason`.
    #[serde(default)]
    pub extra: Option<Map<String, Value>>,
    /// What the facilitator's extensions answered, from its `EXTENSION-RESPONSES` header.
    #[serde(skip)]
    pub extension_responses: Option<Map<String, Value>>,
}

impl VerifyResponse {
    fn refused(reason: String, message: Option<String>, payer: Option<String>) -> Self {
        Self {
            is_valid: false,
            invalid_reason: Some(reason),
            invalid_message: message,
            payer,
            extra: None,
            extension_responses: None,
        }
    }
}

/// What `/settle` answers.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleResponse {
    pub success: bool,
    #[serde(default)]
    pub error_reason: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub payer: Option<String>,
    /// The hash of the settlement's transaction; empty when nothing was sent.
    #[serde(default)]
    pub transaction: String,
    #[serde(default)]
    pub network: String,
    /// Fields this crate does not read. The buyer gets those upstream's schema keeps (`amount`,
    /// `extensions`, `extra`) and no other.
    #[serde(flatten)]
    pub other: Map<String, Value>,
    /// What the facilitator's extensions answered, from its `EXTENSION-RESPONSES` header: for
    /// `bazaar`, whether the listing was cataloged. For the seller, never sent to the buyer.
    #[serde(skip)]
    pub extension_responses: Option<Map<String, Value>>,
    /// The buyer's `PAYMENT-RESPONSE`, when upstream builds it from an error and not from the
    /// answer's fields.
    #[serde(skip)]
    buyer: Option<Map<String, Value>>,
}

impl SettleResponse {
    /// The value of the `PAYMENT-RESPONSE` header: this answer as upstream's client keeps it,
    /// as JSON, in base64.
    pub fn to_header(&self) -> String {
        let fields = match &self.buyer {
            Some(buyer) => buyer.clone(),
            None => self.schema_fields(),
        };
        let json = serde_json::to_vec(&Value::Object(fields)).expect("JSON values only");
        STANDARD.encode(json)
    }

    /// The fields `@x402/core`'s `settleResponseSchema` keeps, a null one left out as it does.
    fn schema_fields(&self) -> Map<String, Value> {
        let mut fields = Map::new();
        fields.insert("success".to_owned(), json!(self.success));
        let optional = [
            ("errorReason", &self.error_reason),
            ("errorMessage", &self.error_message),
            ("payer", &self.payer),
        ];
        for (key, value) in optional {
            if let Some(value) = value {
                fields.insert(key.to_owned(), json!(value));
            }
        }
        fields.insert("transaction".to_owned(), json!(self.transaction));
        fields.insert("network".to_owned(), json!(self.network));
        for key in ["amount", "extensions", "extra"] {
            if let Some(value) = self.other.get(key).filter(|value| !value.is_null()) {
                fields.insert(key.to_owned(), value.clone());
            }
        }
        fields
    }

    /// Upstream's answer for a settlement its client could not make: the error's message as the
    /// reason, nothing sent.
    #[cfg(feature = "axum")]
    pub(crate) fn failed(message: String, network: &str) -> Self {
        Self {
            success: false,
            error_reason: Some(message.clone()),
            error_message: Some(message),
            payer: None,
            transaction: String::new(),
            network: network.to_owned(),
            other: Map::new(),
            extension_responses: None,
            buyer: None,
        }
    }

    /// A settle answer with an error status and a `success` field: upstream's `SettleError`,
    /// never a success, and the `PAYMENT-RESPONSE` its `processSettlement` builds from it.
    fn from_error_status(verdict: &Map<String, Value>) -> Self {
        let reason = verdict.get("errorReason").filter(|value| truthy(value));
        let message = verdict.get("errorMessage").filter(|value| truthy(value));
        let error_reason = match reason {
            Some(reason) => reason.clone(),
            None => Value::String(error_text(UNKNOWN_REASON.to_owned(), message)),
        };
        let error_message = message.cloned().unwrap_or_else(|| error_reason.clone());
        let mut buyer = Map::new();
        buyer.insert("success".to_owned(), Value::Bool(false));
        buyer.insert("errorReason".to_owned(), error_reason.clone());
        buyer.insert("errorMessage".to_owned(), error_message.clone());
        for key in ["payer", "network", "transaction"] {
            if let Some(value) = verdict.get(key) {
                buyer.insert(key.to_owned(), value.clone());
            }
        }
        let text = |key: &str| {
            verdict
                .get(key)
                .filter(|value| !value.is_null())
                .map(js_string)
        };
        Self {
            success: false,
            error_reason: Some(js_string(&error_reason)),
            error_message: Some(js_string(&error_message)),
            payer: text("payer"),
            transaction: text("transaction").unwrap_or_default(),
            network: text("network").unwrap_or_default(),
            other: Map::new(),
            extension_responses: None,
            buyer: Some(buyer),
        }
    }

    /// A transaction was sent and is not final yet: upstream asks the facilitator once more.
    fn sent_and_pending(&self) -> bool {
        !self.success
            && self.error_reason.as_deref() == Some(SETTLEMENT_PENDING)
            && !self.transaction.is_empty()
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
        let json = answer.json.clone().ok_or_else(|| answer.not_json(route))?;
        serde_json::from_value(json).map_err(|_| answer.invalid_data(route))
    }

    /// Asks whether `payment` pays `terms`. Nothing is sent to the network.
    ///
    /// As upstream's client, a verdict sent with an error status is never valid. A 400 or a 413
    /// without a verdict is a refusal too, not an error: the seller's terms passed its own checks
    /// and are small, so what the facilitator could not read, or would not take for its size, is
    /// the buyer's payment. Its `invalid_reason` is then upstream's error message, as the buyer
    /// gets it.
    pub async fn verify(
        &self,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> Result<VerifyResponse, FacilitatorError> {
        let route = "/verify";
        let answer = self.send(route, self.post(route, payment, terms)).await?;
        if !answer.ok {
            if let Some(Value::Object(verdict)) = &answer.json {
                if verdict.contains_key("isValid") {
                    // Upstream's `VerifyError`.
                    let reason = verdict.get("invalidReason").filter(|value| truthy(value));
                    let message = verdict.get("invalidMessage").filter(|value| truthy(value));
                    let reason = reason.map_or_else(|| UNKNOWN_REASON.to_owned(), js_string);
                    let mut refused = VerifyResponse::refused(
                        error_text(reason, message),
                        message.map(js_string),
                        verdict
                            .get("payer")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    );
                    refused.extension_responses = answer.extension_responses;
                    return Ok(refused);
                }
            }
            let error = answer.status_error(route);
            if matches!(answer.status, 400 | 413) {
                let mut refused = VerifyResponse::refused(error.upstream_message(), None, None);
                refused.extension_responses = answer.extension_responses;
                return Ok(refused);
            }
            return Err(error);
        }
        let json = answer.json.clone().ok_or_else(|| answer.not_json(route))?;
        if !fits_verify_schema(&json) {
            return Err(answer.invalid_data(route));
        }
        let mut verified: VerifyResponse =
            serde_json::from_value(json).map_err(|_| answer.invalid_data(route))?;
        verified.extension_responses = answer.extension_responses;
        Ok(verified)
    }

    /// Settles `payment` on Stellar: the transfer the buyer signed, its fee paid by the
    /// facilitator.
    ///
    /// A `settlement_pending` answer with a transaction hash is asked for once more, as upstream's
    /// server does: the transaction was sent, and the facilitator answers the repeat with how it
    /// ended. A second `settlement_pending` is returned as it is; the transaction may still land.
    pub async fn settle(
        &self,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> Result<SettleResponse, FacilitatorError> {
        let settled = self.settle_once(payment, terms).await?;
        if settled.sent_and_pending() {
            return self.settle_once(payment, terms).await;
        }
        Ok(settled)
    }

    async fn settle_once(
        &self,
        payment: &PaymentPayload,
        terms: &PaymentRequirements,
    ) -> Result<SettleResponse, FacilitatorError> {
        let route = "/settle";
        let answer = self.send(route, self.post(route, payment, terms)).await?;
        if !answer.ok {
            if let Some(Value::Object(verdict)) = &answer.json {
                if verdict.contains_key("success") {
                    let mut refused = SettleResponse::from_error_status(verdict);
                    refused.extension_responses = answer.extension_responses;
                    return Ok(refused);
                }
            }
            return Err(answer.status_error(route));
        }
        let json = answer.json.clone().ok_or_else(|| answer.not_json(route))?;
        if !fits_settle_schema(&json) {
            return Err(answer.invalid_data(route));
        }
        let mut settled: SettleResponse =
            serde_json::from_value(json).map_err(|_| answer.invalid_data(route))?;
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

    /// Sends `request` and reads the answer, at most 1 MiB of it, as upstream's `readLimitedText`.
    async fn send(
        &self,
        route: &'static str,
        request: reqwest::RequestBuilder,
    ) -> Result<Answer, FacilitatorError> {
        let failed = |source: reqwest::Error| match source.is_timeout() {
            true => FacilitatorError::Timeout {
                route,
                after: self.timeout,
            },
            false => FacilitatorError::Unreachable { route, source },
        };
        let mut response = request.timeout(self.timeout).send().await.map_err(failed)?;
        let status = response.status();
        let extension_responses = response
            .headers()
            .get(EXTENSION_RESPONSES)
            .and_then(|value| STANDARD.decode(value.as_bytes()).ok())
            .and_then(|bytes| serde_json::from_slice::<Map<String, Value>>(&bytes).ok());
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(failed)? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() > MAX_ANSWER_BYTES {
                return Err(FacilitatorError::TooLarge {
                    route,
                    limit: MAX_ANSWER_BYTES,
                });
            }
        }
        // As `TextDecoder`: bytes that are not UTF-8 become U+FFFD.
        let body = String::from_utf8_lossy(&bytes).into_owned();
        Ok(Answer {
            ok: status.is_success(),
            status: status.as_u16(),
            json: serde_json::from_str(&body).ok(),
            body,
            extension_responses,
        })
    }
}

/// One answer of the facilitator, read whole.
struct Answer {
    ok: bool,
    status: u16,
    /// The body as JSON, when it is JSON.
    json: Option<Value>,
    body: String,
    extension_responses: Option<Map<String, Value>>,
}

impl Answer {
    /// Upstream's error for an answer with an error status and no verdict.
    fn status_error(&self, route: &'static str) -> FacilitatorError {
        // Upstream writes `JSON.stringify(JSON.parse(text))` for JSON, the text as it is
        // otherwise; `compact_json` matches the first for the answers a facilitator sends.
        let shown = match self.json {
            Some(_) => compact_json(&self.body),
            None => self.body.clone(),
        };
        FacilitatorError::Status {
            status: self.status,
            route,
            code: self
                .json
                .as_ref()
                .and_then(|json| json.get("error"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            body: excerpt(&shown),
        }
    }

    fn not_json(&self, route: &'static str) -> FacilitatorError {
        FacilitatorError::NotJson {
            route,
            body: excerpt(&self.body),
        }
    }

    fn invalid_data(&self, route: &'static str) -> FacilitatorError {
        FacilitatorError::InvalidData {
            route,
            body: excerpt(&self.body),
        }
    }
}

/// What a field of upstream's zod schemas takes.
#[derive(Clone, Copy)]
enum Field {
    Bool,
    String,
    /// A string, null, or left out.
    OptionalString,
    /// An object, null, or left out.
    OptionalObject,
}

fn fits(json: &Value, fields: &[(&str, Field)]) -> bool {
    let Value::Object(object) = json else {
        return false;
    };
    fields.iter().all(|(key, field)| {
        matches!(
            (field, object.get(*key)),
            (Field::Bool, Some(Value::Bool(_)))
                | (Field::String, Some(Value::String(_)))
                | (
                    Field::OptionalString,
                    None | Some(Value::Null | Value::String(_))
                )
                | (
                    Field::OptionalObject,
                    None | Some(Value::Null | Value::Object(_))
                )
        )
    })
}

/// `@x402/core`'s `verifyResponseSchema`.
fn fits_verify_schema(json: &Value) -> bool {
    use Field::*;
    fits(
        json,
        &[
            ("isValid", Bool),
            ("invalidReason", OptionalString),
            ("invalidMessage", OptionalString),
            ("payer", OptionalString),
            ("extensions", OptionalObject),
            ("extra", OptionalObject),
        ],
    )
}

/// `@x402/core`'s `settleResponseSchema`.
fn fits_settle_schema(json: &Value) -> bool {
    use Field::*;
    fits(
        json,
        &[
            ("success", Bool),
            ("errorReason", OptionalString),
            ("errorMessage", OptionalString),
            ("payer", OptionalString),
            ("transaction", String),
            ("network", String),
            ("amount", OptionalString),
            ("extensions", OptionalObject),
            ("extra", OptionalObject),
        ],
    )
}

/// The message of upstream's `VerifyError` and `SettleError`: `reason: message`, or the reason.
fn error_text(reason: String, message: Option<&Value>) -> String {
    match message {
        Some(message) => format!("{reason}: {}", js_string(message)),
        None => reason,
    }
}

/// Whether JavaScript takes `value` as true, as `a || b` does.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `value` as a JavaScript template literal writes it. Exact for strings, numbers and booleans,
/// the types a facilitator sends.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::String(text) => text.clone(),
        Value::Number(number) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
            _ => number.to_string(),
        },
        Value::Bool(value) => value.to_string(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// JSON text with the whitespace outside its strings removed, and nothing else changed.
///
/// That is what upstream's `JSON.stringify(JSON.parse(text))` gives for the answers our facilitator
/// sends. JavaScript also rewrites numbers (`1.0` to `1`, `1e3` to `1000`), escapes (`é` to
/// `é`) and duplicate keys (the last wins), which stay here as the facilitator sent them.
/// Re-serializing through `serde_json` would sort the keys, unless its `preserve_order` feature is
/// on for the seller's whole build.
fn compact_json(text: &str) -> String {
    let mut compact = String::with_capacity(text.len());
    let (mut in_string, mut escaped) = (false, false);
    for c in text.chars() {
        if in_string {
            compact.push(c);
            match c {
                _ if escaped => escaped = false,
                '\\' => escaped = true,
                '"' => in_string = false,
                _ => {}
            }
        } else if c == '"' {
            in_string = true;
            compact.push(c);
        } else if !c.is_whitespace() {
            compact.push(c);
        }
    }
    compact
}

/// JavaScript's `\s`: Unicode white space and the byte order mark.
fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Upstream's `responseExcerpt`: white space folded, at most 200 characters with "..." in the
/// last three, and a word for an empty answer.
fn excerpt(text: &str) -> String {
    let compact = text
        .split(js_space)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if compact.is_empty() {
        return "<empty response>".to_owned();
    }
    if compact.encode_utf16().count() <= EXCERPT_UNITS {
        return compact;
    }
    let mut units = 0;
    let mut cut = String::new();
    for c in compact.chars() {
        units += c.len_utf16();
        if units > EXCERPT_UNITS - 3 {
            break;
        }
        cut.push(c);
    }
    format!("{cut}...")
}
