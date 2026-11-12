//! The facilitator client, against a facilitator on a local port.

mod support;

use std::time::Duration;

use serde_json::json;
use stellar_x402::{Facilitator, FacilitatorError};
use support::{payment, payment_json, terms, FakeFacilitator, Reply, HASH, PAYER};

#[tokio::test]
async fn supported_reads_what_the_facilitator_supports() {
    let fake = FakeFacilitator::start().await;

    let supported = Facilitator::new(&fake.url)
        .unwrap()
        .supported()
        .await
        .unwrap();

    assert!(supported.supports(&terms()));
    assert_eq!(fake.paths(), ["/supported"]);
}

#[tokio::test]
async fn a_trailing_slash_in_the_url_is_dropped() {
    let fake = FakeFacilitator::start().await;

    Facilitator::new(&format!("{}/", fake.url))
        .unwrap()
        .supported()
        .await
        .unwrap();

    assert_eq!(fake.paths(), ["/supported"]);
}

#[tokio::test]
async fn verify_sends_the_payment_and_the_sellers_terms() {
    let fake = FakeFacilitator::start().await;

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(verified.is_valid);
    assert_eq!(verified.payer.as_deref(), Some(PAYER));
    let [seen] = &fake.seen()[..] else {
        panic!("one request expected")
    };
    assert_eq!(seen.path, "/verify");
    assert_eq!(
        seen.body,
        json!({
            "x402Version": 2,
            "paymentPayload": payment_json(&terms()),
            "paymentRequirements": terms()
        })
    );
}

#[tokio::test]
async fn a_refused_payment_comes_back_with_its_reason_and_message() {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(
        200,
        json!({
            "isValid": false,
            "invalidReason": "invalid_exact_stellar_payer_trustline_missing",
            "invalidMessage": "The payer has no trustline to USDC. Add one, then pay again.",
            "payer": PAYER
        }),
    ));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!verified.is_valid);
    assert_eq!(
        verified.invalid_reason.as_deref(),
        Some("invalid_exact_stellar_payer_trustline_missing")
    );
    assert_eq!(
        verified.invalid_message.as_deref(),
        Some("The payer has no trustline to USDC. Add one, then pay again.")
    );
}

#[tokio::test]
async fn a_refusal_sent_with_an_error_status_is_still_a_refusal() {
    // Upstream's client reads `isValid` from a non-2xx body too.
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(
        400,
        json!({ "isValid": false, "invalidReason": "invalid_payload" }),
    ));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!verified.is_valid);
    assert_eq!(verified.invalid_reason.as_deref(), Some("invalid_payload"));
}

#[tokio::test]
async fn settle_returns_the_transaction_and_what_the_extensions_answered() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(
        Reply::json(
            200,
            json!({
                "success": true,
                "payer": PAYER,
                "transaction": HASH,
                "network": "stellar:testnet"
            }),
        )
        .extension_responses(json!({ "bazaar": { "status": "success" } })),
    );

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(settled.success);
    assert_eq!(settled.transaction, HASH);
    assert_eq!(settled.network, "stellar:testnet");
    assert_eq!(settled.payer.as_deref(), Some(PAYER));
    assert_eq!(
        settled.extension_responses,
        json!({ "bazaar": { "status": "success" } })
            .as_object()
            .cloned()
    );
    assert_eq!(fake.paths(), ["/settle"]);
}

#[tokio::test]
async fn a_failed_settlement_comes_back_with_its_reason_and_message() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(
        200,
        json!({
            "success": false,
            "errorReason": "spend_budget_exhausted",
            "errorMessage": "This payer's fee budget is used up for today.",
            "transaction": "",
            "network": "stellar:testnet"
        }),
    ));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!settled.success);
    assert_eq!(
        settled.error_reason.as_deref(),
        Some("spend_budget_exhausted")
    );
    assert_eq!(
        settled.error_message.as_deref(),
        Some("This payer's fee budget is used up for today.")
    );
}

#[tokio::test]
async fn the_api_key_goes_to_verify_and_settle_as_a_bearer_token_and_not_to_supported() {
    let fake = FakeFacilitator::start().await;
    let facilitator = Facilitator::new(&fake.url)
        .unwrap()
        .with_api_key("sx402_live_abc");

    facilitator.supported().await.unwrap();
    facilitator
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();
    facilitator
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    let sent: Vec<_> = fake
        .seen()
        .into_iter()
        .map(|seen| (seen.path, seen.authorization))
        .collect();
    assert_eq!(
        sent,
        [
            ("/supported".to_owned(), None),
            (
                "/verify".to_owned(),
                Some("Bearer sx402_live_abc".to_owned())
            ),
            (
                "/settle".to_owned(),
                Some("Bearer sx402_live_abc".to_owned())
            ),
        ]
    );
}

#[tokio::test]
async fn without_an_api_key_no_authorization_is_sent() {
    let fake = FakeFacilitator::start().await;

    Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert_eq!(fake.seen()[0].authorization, None);
}

#[tokio::test]
async fn an_error_status_names_the_status_and_the_facilitators_code() {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(401, json!({ "error": "missing_api_key" })));

    let error = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(
        matches!(&error, FacilitatorError::Status { status: 401, code: Some(code), .. } if code == "missing_api_key"),
        "{error:?}"
    );
    assert_eq!(
        error.to_string(),
        "the facilitator answered 401 on /verify: missing_api_key"
    );
}

#[tokio::test]
async fn an_answer_that_is_not_what_the_route_returns_is_an_error() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::text(200, "<html>gateway</html>"));

    let error = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(matches!(error, FacilitatorError::Body { .. }), "{error:?}");
}

#[tokio::test]
async fn a_facilitator_that_does_not_answer_in_time_is_an_error() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(200, json!({})).after(Duration::from_secs(5)));
    let facilitator = Facilitator::new(&fake.url)
        .unwrap()
        .with_timeout(Duration::from_millis(100));

    let error = facilitator
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(
        matches!(error, FacilitatorError::Timeout { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_facilitator_that_cannot_be_reached_is_an_error() {
    // Nothing listens on port 1.
    let error = Facilitator::new("http://127.0.0.1:1")
        .unwrap()
        .supported()
        .await
        .unwrap_err();

    assert!(
        matches!(error, FacilitatorError::Unreachable { .. }),
        "{error:?}"
    );
}

#[test]
fn a_url_that_is_not_http_is_refused_when_the_client_is_made() {
    assert!(matches!(
        Facilitator::new("facilitator.example.com"),
        Err(FacilitatorError::Url { .. })
    ));
    assert!(matches!(
        Facilitator::new("ftp://example.com"),
        Err(FacilitatorError::Url { .. })
    ));
}

#[test]
fn the_api_key_is_left_out_of_debug_output() {
    let facilitator = Facilitator::new("https://facilitator.example")
        .unwrap()
        .with_api_key("secret-key");

    let debug = format!("{facilitator:?}");

    assert!(!debug.contains("secret-key"), "{debug}");
    assert!(debug.contains("https://facilitator.example"), "{debug}");
}
