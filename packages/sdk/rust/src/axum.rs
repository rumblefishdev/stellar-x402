//! A tower layer that charges for an axum route.
//!
//! ```no_run
//! use axum::{routing::get, Router};
//! use stellar_x402::axum::PaymentGate;
//! use stellar_x402::{Facilitator, Network, Price};
//!
//! # async fn app() -> Result<Router, Box<dyn std::error::Error>> {
//! let facilitator = Facilitator::new("https://x402-facilitator.sorobanscan.com")?;
//! let gate = PaymentGate::connect(facilitator).await?;
//! let paid = gate.charge(
//!     Network::Testnet,
//!     "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3",
//!     Price::usdc("0.001")?,
//! )?;
//! Ok(Router::new().route("/weather", get(|| async { "14 °C" }).route_layer(paid)))
//! # }
//! ```
//!
//! `route_layer`, not `layer`: `layer` also wraps the answer to a method the route does not have,
//! so a `POST` or a browser's `OPTIONS` would get 402 in place of 405.
//!
//! A request without a payment gets 402 and the terms. A request with one is checked by the
//! facilitator, then the route runs, and only when the route answers without an error is the
//! payment settled: a request the route refuses costs the buyer nothing.
//!
//! The payment is settled once the route's answer has its status and headers, before its body is
//! sent: a streamed body that breaks halfway is still paid for. Upstream's middleware holds the
//! whole body before it settles; doing the same is part 2's (task 0140).
//!
//! Every answer the layer gives the buyer is the one `@x402/express` 2.31.0 gives for the same
//! request and the same facilitator answer: status, `PAYMENT-REQUIRED`, `PAYMENT-RESPONSE`,
//! `Cache-Control` and body, its error messages word for word.

use std::convert::Infallible;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use ::axum::body::Body;
use ::axum::extract::{OriginalUri, Request};
use ::axum::http::header::{ACCEPT, CACHE_CONTROL, CONTENT_TYPE, HOST, USER_AGENT};
use ::axum::http::{HeaderValue, StatusCode};
use ::axum::response::Response;
use serde_json::{json, Value};
use tower_layer::Layer;
use tower_service::Service;

use crate::{
    AddressError, Facilitator, FacilitatorError, Listing, Network, PaymentPayload, PaymentRequired,
    PaymentRequirements, Price, ResourceInfo, SettleResponse, Supported, VerifyResponse,
};

const PAYMENT_SIGNATURE: &str = "PAYMENT-SIGNATURE";
const PAYMENT_REQUIRED: &str = "PAYMENT-REQUIRED";
const PAYMENT_RESPONSE: &str = "PAYMENT-RESPONSE";

/// Why a gate or a paid route could not be made.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum GateError {
    #[error(transparent)]
    Facilitator(#[from] FacilitatorError),
    #[error("the facilitator does not settle the exact scheme on {network}")]
    Unsupported { network: Network },
    #[error(transparent)]
    Address(#[from] AddressError),
}

/// What happened to a payment, for the seller's logs and metrics. The buyer sees none of it
/// beyond what the answer carries.
#[derive(Debug)]
#[non_exhaustive]
pub enum PaymentEvent<'a> {
    /// A payment was settled. `extension_responses` holds the facilitator's answer about the
    /// listing: for `bazaar`, whether the catalog took it.
    Settled(&'a SettleResponse),
    /// The route answered, and the facilitator then refused to settle, or answered
    /// `settlement_pending` again when asked a second time: that transaction was sent and may
    /// still land. The buyer got 402 and the facilitator's `PAYMENT-RESPONSE`.
    SettleRefused(&'a SettleResponse),
    /// The facilitator found the payment invalid, or could not read it (a 400, or a 413 for its
    /// size). The route did not run; the buyer got 402.
    VerifyRefused(&'a VerifyResponse),
    /// The facilitator gave no answer to act on, or refused the seller itself, as with a wrong
    /// API key. The buyer got what `@x402/express` answers: 402 with the error's message, or 502
    /// when the facilitator's answer could not be read or came too late.
    FacilitatorFailed(&'a FacilitatorError),
}

type OnEvent = Arc<dyn Fn(&PaymentEvent<'_>) + Send + Sync>;

/// The account that paid for the request, as the facilitator named it. A request extension:
/// take it in a handler as `Extension<Payer>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payer(pub String);

/// The seller's side of the payments: a facilitator, and what it supports.
#[derive(Clone)]
pub struct PaymentGate {
    facilitator: Facilitator,
    supported: Supported,
    base_url: Option<String>,
    on_event: Option<OnEvent>,
}

impl PaymentGate {
    /// Reads what the facilitator supports. Fails when it cannot be reached, so a seller with a
    /// wrong facilitator URL does not start.
    pub async fn connect(facilitator: Facilitator) -> Result<Self, GateError> {
        let supported = facilitator.supported().await?;
        Ok(Self {
            facilitator,
            supported,
            base_url: None,
            on_event: None,
        })
    }

    /// The seller's public address, such as `https://api.example.com`: the 402 names the resource
    /// by it. Without one the request's `Host` header is used, with `http`, which is wrong behind
    /// a proxy that ends TLS.
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.base_url = Some(url.into().trim_end_matches('/').to_owned());
        self
    }

    /// Calls `observe` with every [`PaymentEvent`], on the request's task: keep it quick.
    pub fn on_event(mut self, observe: impl Fn(&PaymentEvent<'_>) + Send + Sync + 'static) -> Self {
        self.on_event = Some(Arc::new(observe));
        self
    }

    /// A layer that charges `price` for a route, paid to `pay_to` on `network`.
    ///
    /// Fails when an address is mistyped or the facilitator does not settle on `network`.
    pub fn charge(
        &self,
        network: Network,
        pay_to: impl Into<String>,
        price: Price,
    ) -> Result<PaidRoute, GateError> {
        let terms = PaymentRequirements::exact(network, pay_to, price)?;
        if !self.supported.supports(&terms) {
            return Err(GateError::Unsupported { network });
        }
        Ok(PaidRoute {
            gate: self.clone(),
            terms: terms.with_supported(&self.supported),
            description: None,
            mime_type: None,
            listing: None,
        })
    }
}

/// One route's price and description. A tower layer: `get(handler).route_layer(paid)`.
#[derive(Clone)]
pub struct PaidRoute {
    gate: PaymentGate,
    terms: PaymentRequirements,
    description: Option<String>,
    mime_type: Option<String>,
    listing: Option<Listing>,
}

impl PaidRoute {
    /// What the route gives, in a sentence. The catalog shows it.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The media type of the route's answer.
    pub fn mime_type(mut self, mime_type: impl Into<String>) -> Self {
        self.mime_type = Some(mime_type.into());
        self
    }

    /// Asks a facilitator that catalogs to list the route.
    pub fn listing(mut self, listing: Listing) -> Self {
        self.listing = Some(listing);
        self
    }

    fn emit(&self, event: PaymentEvent<'_>) {
        if let Some(observe) = &self.gate.on_event {
            observe(&event);
        }
    }

    /// The 402 answer for `request`.
    fn required(&self, request: &Request) -> PaymentRequired {
        let uri = request
            .extensions()
            .get::<OriginalUri>()
            .map_or(request.uri(), |uri| &uri.0);
        let path = uri.path_and_query().map_or("/", |path| path.as_str());
        let url = match &self.gate.base_url {
            Some(base_url) => format!("{base_url}{path}"),
            None => {
                let host = request
                    .headers()
                    .get(HOST)
                    .and_then(|host| host.to_str().ok());
                format!("http://{}{path}", host.unwrap_or("localhost"))
            }
        };
        let mut resource = ResourceInfo::new(url);
        if let Some(description) = &self.description {
            resource = resource.description(description);
        }
        if let Some(mime_type) = &self.mime_type {
            resource = resource.mime_type(mime_type);
        }
        let required = PaymentRequired::new(resource, vec![self.terms.clone()]);
        match &self.listing {
            Some(listing) => required.with_listing(listing, request.method().as_str()),
            None => required,
        }
    }

    async fn handle<S>(&self, mut request: Request, mut route: S) -> Response
    where
        S: Service<Request, Response = Response, Error = Infallible>,
    {
        let required = self.required(&request);
        // A header that cannot be read is no payment, as in upstream's middleware.
        let payment = request
            .headers()
            .get(PAYMENT_SIGNATURE)
            .and_then(|header| header.to_str().ok())
            .and_then(|header| PaymentPayload::from_header(header).ok());
        let Some(payment) = payment else {
            if from_a_browser(&request) {
                return paywall_page(&required);
            }
            return payment_required(&required);
        };
        if !payment.accepts(&self.terms) {
            let required = required.with_error("No matching payment requirements");
            return payment_required(&required);
        }

        let verified = match self.gate.facilitator.verify(&payment, &self.terms).await {
            Ok(verified) => verified,
            Err(error) => {
                self.emit(PaymentEvent::FacilitatorFailed(&error));
                if error.is_response_error() {
                    return facilitator_error(&error);
                }
                return payment_required(&required.with_error(error.upstream_message()));
            }
        };
        if !verified.is_valid {
            self.emit(PaymentEvent::VerifyRefused(&verified));
            let required = required.with_reason(verified.invalid_reason.as_deref());
            return payment_required(&required);
        }
        if let Some(payer) = &verified.payer {
            request.extensions_mut().insert(Payer(payer.clone()));
        }

        let mut response = match route.call(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
        // The route refused or failed: nothing was sold, so nothing is settled.
        if response.status().is_client_error() || response.status().is_server_error() {
            return response;
        }

        match self.gate.facilitator.settle(&payment, &self.terms).await {
            Ok(settled) if settled.success => {
                self.emit(PaymentEvent::Settled(&settled));
                let headers = response.headers_mut();
                headers.insert(PAYMENT_RESPONSE, header_value(&settled.to_header()));
                let cache_control = private(headers.get(CACHE_CONTROL));
                headers.insert(CACHE_CONTROL, cache_control);
                response
            }
            Ok(settled) => {
                self.emit(PaymentEvent::SettleRefused(&settled));
                settlement_failed(&settled)
            }
            Err(error) => {
                self.emit(PaymentEvent::FacilitatorFailed(&error));
                if error.is_response_error() {
                    return facilitator_error(&error);
                }
                let network = self.terms.network().as_str();
                settlement_failed(&SettleResponse::failed(error.upstream_message(), network))
            }
        }
    }
}

/// Upstream's `isWebBrowser`: a request that takes HTML from a browser's user agent.
fn from_a_browser(request: &Request) -> bool {
    let header = |name| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    };
    header(ACCEPT).contains("text/html") && header(USER_AGENT).contains("Mozilla")
}

/// `@x402/core` 2.31.0's `FALLBACK_PAYWALL_HTML` (Apache-2.0, x402 Foundation): the page a browser
/// gets for a scheme without an in-browser paywall, as Stellar is upstream.
const PAYWALL_PAGE: &str = r#"<!DOCTYPE html>
<html>
  <head>
    <title>Payment Required</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
  </head>
  <body>
    <div style="max-width: 600px; margin: 50px auto; padding: 20px; font-family: system-ui, -apple-system, sans-serif;">
      <h1>Payment Required</h1>
      <p>This resource is protected by the x402 payment protocol.</p>
      <p style="margin-top: 2rem; padding: 1rem; background: #fef3c7; border-radius: 0.5rem;">
        <strong>Note to developers:</strong> install <code>@x402/paywall</code> to enable
        the in-browser wallet connection and payment UI. Programmatic clients should read
        the payment requirements from the 402 response headers and JSON body.
      </p>
    </div>
  </body>
</html>"#;

fn paywall_page(required: &PaymentRequired) -> Response {
    let mut response = Response::new(Body::from(PAYWALL_PAGE));
    *response.status_mut() = StatusCode::PAYMENT_REQUIRED;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html"));
    headers.insert(PAYMENT_REQUIRED, header_value(&required.to_header()));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// The route's `Cache-Control` with `private` added, as upstream does: a shared cache must not
/// keep a paid answer and its `PAYMENT-RESPONSE`.
fn private(route: Option<&HeaderValue>) -> HeaderValue {
    let Some((header, value)) = route.and_then(|header| Some((header, header.to_str().ok()?)))
    else {
        return HeaderValue::from_static("private");
    };
    let is_private = value
        .split(',')
        .any(|directive| directive.trim().eq_ignore_ascii_case("private"));
    if is_private {
        return header.clone();
    }
    HeaderValue::from_str(&format!("{value}, private")).expect("a header value and ASCII")
}

/// Base64 and the header names here are plain ASCII.
fn header_value(text: &str) -> HeaderValue {
    HeaderValue::from_str(text).expect("base64 is a valid header value")
}

fn json_response(status: StatusCode, body: &Value) -> Response {
    let mut response = Response::new(Body::from(body.to_string()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response
}

/// 402 with the terms, and the refusal's reason in the body too, as `@x402/core` 2.31.0's
/// `createHTTPResponse`. No cache may keep it.
fn payment_required(required: &PaymentRequired) -> Response {
    let body = match required.error() {
        Some(error) => json!({ "error": error }),
        None => json!({}),
    };
    let mut response = json_response(StatusCode::PAYMENT_REQUIRED, &body);
    let headers = response.headers_mut();
    headers.insert(PAYMENT_REQUIRED, header_value(&required.to_header()));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// 402 with the failed settlement in `PAYMENT-RESPONSE` and an empty body, as upstream's
/// `buildSettlementFailureResponse`. The route's answer is not sent.
fn settlement_failed(settled: &SettleResponse) -> Response {
    let mut response = json_response(StatusCode::PAYMENT_REQUIRED, &json!({}));
    let headers = response.headers_mut();
    headers.insert(PAYMENT_RESPONSE, header_value(&settled.to_header()));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Upstream's answer to a `FacilitatorResponseError`: 502 and the error's message.
fn facilitator_error(error: &FacilitatorError) -> Response {
    json_response(
        StatusCode::BAD_GATEWAY,
        &json!({ "error": error.upstream_message() }),
    )
}

impl<S> Layer<S> for PaidRoute {
    type Service = PaidService<S>;

    fn layer(&self, route: S) -> Self::Service {
        PaidService {
            paid: Arc::new(self.clone()),
            route,
        }
    }
}

/// A route behind its [`PaidRoute`].
#[derive(Clone)]
pub struct PaidService<S> {
    paid: Arc<PaidRoute>,
    route: S,
}

impl<S> Service<Request> for PaidService<S>
where
    S: Service<Request, Response = Response, Error = Infallible> + Clone + Send + 'static,
    S::Future: Send,
{
    type Response = Response;
    type Error = Infallible;
    type Future = Pin<Box<dyn Future<Output = Result<Response, Infallible>> + Send>>;

    fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Infallible>> {
        self.route.poll_ready(context)
    }

    fn call(&mut self, request: Request) -> Self::Future {
        let paid = self.paid.clone();
        // The clone that was polled ready takes the call; a fresh one waits for the next.
        let fresh = self.route.clone();
        let route = std::mem::replace(&mut self.route, fresh);
        Box::pin(async move { Ok(paid.handle(request, route).await) })
    }
}
