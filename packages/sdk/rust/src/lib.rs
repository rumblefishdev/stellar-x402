//! Charge for an HTTP route with x402 payments on Stellar.
//!
//! A seller answers a request that carries no payment with 402 and its terms, and checks and
//! settles the payment that follows through a facilitator. The seller signs nothing and holds no
//! key: the buyer signs, and the facilitator pays the network fee.
//!
//! With the feature `axum`, on by default, [`axum::PaymentGate`] does all of it as a layer on a
//! route. Without it, the same parts are here to build on: the 402 answer ([`PaymentRequired`]) with its `bazaar`
//! listing ([`Listing`]), the buyer's payment ([`PaymentPayload`]) and the facilitator's client
//! ([`Facilitator`]).

#[cfg(feature = "axum")]
pub mod axum;
mod bazaar;
mod facilitator;
mod network;
mod payment;
mod price;
mod terms;

pub use bazaar::Listing;
pub use facilitator::{Facilitator, FacilitatorError, SettleResponse, VerifyResponse};
pub use network::Network;
pub use payment::{PaymentHeaderError, PaymentPayload};
pub use price::{Price, PriceError};
pub use terms::{
    AddressError, PaymentRequired, PaymentRequirements, ResourceInfo, Supported, SupportedKind,
};

/// Compiles the README's examples as doc tests, so they stay true. They use the axum layer.
#[cfg(all(doctest, feature = "axum"))]
#[doc = include_str!("../README.md")]
struct ReadmeExamples;
