//! The wire types of the 402 answer, x402 version 2.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use stellar_strkey::Strkey;

use crate::{Listing, Network, Price};

const X402_VERSION: u8 = 2;
const EXACT: &str = "exact";
/// Upstream's default: how long a buyer's signed payment stays valid.
const MAX_TIMEOUT_SECONDS: u64 = 300;
/// The one field upstream's Stellar scheme copies from the facilitator's `/supported`.
const ARE_FEES_SPONSORED: &str = "areFeesSponsored";

/// Why terms were refused. The address is left out: it may be a secret key pasted by mistake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum AddressError {
    #[error("the account to pay is not a Stellar account (G…, M…) or contract (C…) address")]
    PayTo,
    #[error("the token is not a Stellar contract (C…) address")]
    Token,
}

/// One way to pay for a resource: the scheme, the network, the token, the amount and who is paid.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequirements {
    scheme: String,
    network: Network,
    amount: String,
    asset: String,
    pay_to: String,
    max_timeout_seconds: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    extra: Option<Map<String, Value>>,
}

impl PaymentRequirements {
    /// Terms of the `exact` scheme: the buyer pays `price` to `pay_to` on `network`.
    ///
    /// `pay_to` is an account (`G…`), a muxed account (`M…`) or a contract (`C…`). It and the
    /// token's contract are checked here, since a mistyped address fails every payment.
    pub fn exact(
        network: Network,
        pay_to: impl Into<String>,
        price: Price,
    ) -> Result<Self, AddressError> {
        let pay_to = pay_to.into();
        let asset = price.asset_on(network);
        let payable = matches!(
            Strkey::from_string(&pay_to),
            Ok(Strkey::PublicKeyEd25519(_) | Strkey::MuxedAccountEd25519(_) | Strkey::Contract(_))
        );
        if !payable {
            return Err(AddressError::PayTo);
        }
        if !matches!(Strkey::from_string(&asset), Ok(Strkey::Contract(_))) {
            return Err(AddressError::Token);
        }
        Ok(Self {
            scheme: EXACT.to_owned(),
            network,
            amount: price.amount().to_string(),
            asset,
            pay_to,
            max_timeout_seconds: MAX_TIMEOUT_SECONDS,
            extra: None,
        })
    }

    /// Adds what the facilitator says about these terms' scheme and network: whether it pays the
    /// network fee. A buyer's client reads it before it signs.
    pub fn with_supported(mut self, supported: &Supported) -> Self {
        let sponsored = supported
            .kind_of(&self)
            .and_then(|kind| kind.extra.as_ref()?.get(ARE_FEES_SPONSORED)?.as_bool());
        if let Some(sponsored) = sponsored {
            self.extra
                .get_or_insert_with(Map::new)
                .insert(ARE_FEES_SPONSORED.to_owned(), Value::Bool(sponsored));
        }
        self
    }
}

/// The resource a payment buys.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceInfo {
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mime_type: Option<String>,
}

impl ResourceInfo {
    /// The resource at `url`: the request's full URL, its query string included, as upstream's
    /// middleware sends it.
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            description: None,
            mime_type: None,
        }
    }

    /// What the resource is, in a sentence.
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// The media type of the resource's answer.
    pub fn mime_type(mut self, mime_type: impl Into<String>) -> Self {
        self.mime_type = Some(mime_type.into());
        self
    }
}

/// The 402 answer: the resource and every way to pay for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRequired {
    x402_version: u8,
    error: String,
    resource: ResourceInfo,
    accepts: Vec<PaymentRequirements>,
    #[serde(skip_serializing_if = "Map::is_empty")]
    extensions: Map<String, Value>,
}

impl PaymentRequired {
    /// The answer to a request that carries no payment.
    pub fn new(resource: ResourceInfo, accepts: Vec<PaymentRequirements>) -> Self {
        Self {
            x402_version: X402_VERSION,
            error: "Payment required".to_owned(),
            resource,
            accepts,
            extensions: Map::new(),
        }
    }

    /// Says why a payment was refused, in place of "Payment required": a reason code from the
    /// facilitator, or upstream's wording.
    pub fn with_error(mut self, error: impl Into<String>) -> Self {
        self.error = error.into();
        self
    }

    /// Asks a facilitator that catalogs to list the route, as `listing` describes it. `method` is
    /// the method of the request being answered.
    pub fn with_listing(mut self, listing: &Listing, method: &str) -> Self {
        self.extensions
            .insert("bazaar".to_owned(), listing.extension(method));
        self
    }

    /// The value of the `PAYMENT-REQUIRED` header: this answer as JSON, in base64.
    pub fn to_header(&self) -> String {
        let json =
            serde_json::to_vec(self).expect("the answer is strings, numbers and JSON values");
        STANDARD.encode(json)
    }
}

/// What a facilitator's `/supported` answers; only what a seller reads from it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Supported {
    #[serde(default)]
    kinds: Vec<SupportedKind>,
}

impl Supported {
    /// Whether the facilitator verifies and settles payments for `terms`: their scheme, on their
    /// network.
    pub fn supports(&self, terms: &PaymentRequirements) -> bool {
        self.kind_of(terms).is_some()
    }

    fn kind_of(&self, terms: &PaymentRequirements) -> Option<&SupportedKind> {
        self.kinds.iter().find(|kind| {
            kind.x402_version == u64::from(X402_VERSION)
                && kind.scheme == terms.scheme
                && kind.network == terms.network.as_str()
        })
    }
}

/// One scheme on one network that a facilitator verifies and settles.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportedKind {
    x402_version: u64,
    scheme: String,
    network: String,
    #[serde(default)]
    extra: Option<Map<String, Value>>,
}
