//! The buyer's payment, read from the `PAYMENT-SIGNATURE` header, and matched to the seller's terms.

mod support;

use serde_json::json;
use stellar_x402::{Network, PaymentHeaderError, PaymentPayload, PaymentRequirements, Price};
use support::{header_of, payment_json, terms, PAY_TO};

#[test]
fn a_payment_for_the_sellers_terms_matches_them() {
    let payment = PaymentPayload::from_header(&header_of(&payment_json(&terms()))).unwrap();

    assert!(payment.accepts(&terms()));
}

#[test]
fn a_payment_for_another_amount_does_not_match() {
    let cheaper =
        PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::usdc("0.0001").unwrap())
            .unwrap();
    let payment = PaymentPayload::from_header(&header_of(&payment_json(&cheaper))).unwrap();

    assert!(!payment.accepts(&terms()));
}

#[test]
fn a_payment_to_another_account_does_not_match() {
    let other = "GAZQTB6FZ6O7GPATG3OXCV5PPI3Y62RVF7GEKXF3P53VJPLKLBQSZFKG";
    let elsewhere =
        PaymentRequirements::exact(Network::Testnet, other, Price::usdc("0.001").unwrap()).unwrap();
    let payment = PaymentPayload::from_header(&header_of(&payment_json(&elsewhere))).unwrap();

    assert!(!payment.accepts(&terms()));
}

#[test]
fn a_payment_may_add_to_extra_but_not_change_what_the_seller_put_there() {
    // Upstream's rule: the seller's `extra` is a subset of the echoed one.
    let mut added = payment_json(&terms());
    added["accepted"]["extra"]["note"] = json!("from the client");
    let mut changed = payment_json(&terms());
    changed["accepted"]["extra"]["areFeesSponsored"] = json!(false);
    let mut dropped = payment_json(&terms());
    dropped["accepted"].as_object_mut().unwrap().remove("extra");

    assert!(PaymentPayload::from_header(&header_of(&added))
        .unwrap()
        .accepts(&terms()));
    assert!(!PaymentPayload::from_header(&header_of(&changed))
        .unwrap()
        .accepts(&terms()));
    assert!(!PaymentPayload::from_header(&header_of(&dropped))
        .unwrap()
        .accepts(&terms()));
}

#[test]
fn a_header_that_is_not_base64_json_is_refused() {
    assert_eq!(
        PaymentPayload::from_header("not base64!").unwrap_err(),
        PaymentHeaderError::NotBase64
    );
    assert_eq!(
        PaymentPayload::from_header(&header_of(&json!("text"))).unwrap_err(),
        PaymentHeaderError::NotAPayment
    );
    assert_eq!(
        PaymentPayload::from_header("bm90IGpzb24=").unwrap_err(),
        PaymentHeaderError::NotAPayment
    );
}

#[test]
fn a_payment_of_another_protocol_version_is_refused() {
    let mut old = payment_json(&terms());
    old["x402Version"] = json!(1);

    assert_eq!(
        PaymentPayload::from_header(&header_of(&old)).unwrap_err(),
        PaymentHeaderError::UnsupportedVersion
    );
}
