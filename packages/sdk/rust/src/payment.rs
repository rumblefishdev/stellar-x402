//! The buyer's payment, as the `PAYMENT-SIGNATURE` header carries it.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use serde_json::{Map, Value};

use crate::PaymentRequirements;

/// A payment a buyer's client signed for one of the seller's terms.
///
/// Kept as the JSON it arrived in and passed to the facilitator unchanged: the seller reads only
/// which terms it was made for.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(transparent)]
pub struct PaymentPayload(Map<String, Value>);

/// Why a `PAYMENT-SIGNATURE` header was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum PaymentHeaderError {
    #[error("the PAYMENT-SIGNATURE header is not base64")]
    NotBase64,
    #[error("the PAYMENT-SIGNATURE header does not hold a payment")]
    NotAPayment,
    #[error("the payment is not x402 version 2")]
    UnsupportedVersion,
}

impl PaymentPayload {
    /// Reads the value of the `PAYMENT-SIGNATURE` header: a payment as JSON, in base64.
    pub fn from_header(header: &str) -> Result<Self, PaymentHeaderError> {
        let bytes = STANDARD
            .decode(header.trim())
            .map_err(|_| PaymentHeaderError::NotBase64)?;
        let Ok(Value::Object(payment)) = serde_json::from_slice(&bytes) else {
            return Err(PaymentHeaderError::NotAPayment);
        };
        match payment.get("x402Version") {
            Some(version) if version.as_u64() == Some(2) => Ok(Self(payment)),
            Some(_) => Err(PaymentHeaderError::UnsupportedVersion),
            None => Err(PaymentHeaderError::NotAPayment),
        }
    }

    /// Whether the payment was made for `terms`, by upstream's rule: the terms it echoes equal
    /// the seller's in every field but `extra`, and hold everything the seller's `extra` holds.
    pub fn accepts(&self, terms: &PaymentRequirements) -> bool {
        let (Ok(Value::Object(mut ours)), Some(Value::Object(echoed))) =
            (serde_json::to_value(terms), self.0.get("accepted"))
        else {
            return false;
        };
        let mut echoed = echoed.clone();
        let our_extra = ours.remove("extra");
        let echoed_extra = echoed.remove("extra");
        if ours != echoed {
            return false;
        }
        match our_extra {
            Some(Value::Object(our_extra)) => our_extra.iter().all(|(key, value)| {
                echoed_extra.as_ref().and_then(|extra| extra.get(key)) == Some(value)
            }),
            _ => true,
        }
    }
}
