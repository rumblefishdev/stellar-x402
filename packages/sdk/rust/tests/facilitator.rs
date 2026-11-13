//! The facilitator client, against a facilitator on a local port.

mod support;

use std::time::Duration;

use axum::http::header::LOCATION;
use axum::http::StatusCode;
use axum::Router;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
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
async fn a_verdict_sent_with_an_error_status_is_never_valid() {
    // Upstream's client throws a `VerifyError` for any non-2xx answer with `isValid`, so the
    // route never runs; its reason, with no `invalidReason`, is "unknown reason".
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(500, json!({ "isValid": true, "payer": PAYER })));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!verified.is_valid);
    assert_eq!(verified.invalid_reason.as_deref(), Some("unknown reason"));
}

#[tokio::test]
async fn a_refusal_sent_with_an_error_status_carries_its_message_as_upstream_words_it() {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(
        400,
        json!({
            "isValid": false,
            "invalidReason": "invalid_exact_stellar_payer_trustline_missing",
            "invalidMessage": "The payer has no trustline to USDC."
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
        Some("invalid_exact_stellar_payer_trustline_missing: The payer has no trustline to USDC.")
    );
}

#[tokio::test]
async fn a_verify_answer_upstreams_schema_refuses_is_an_error() {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(200, json!({ "isValid": "yes" })));

    let error = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(
        matches!(&error, FacilitatorError::InvalidData { body, .. } if body == r#"{"isValid":"yes"}"#),
        "{error:?}"
    );
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
async fn a_payment_the_facilitator_cannot_read_is_a_refusal() {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(400, json!({ "error": "bad_request" })));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!verified.is_valid);
    // Upstream's error for it, word for word: the buyer's 402 carries it.
    assert_eq!(
        verified.invalid_reason.as_deref(),
        Some(r#"Facilitator verify failed (400): {"error":"bad_request"}"#)
    );
}

#[tokio::test]
async fn a_payment_too_large_for_the_facilitator_is_a_refusal() {
    // Our facilitator answers a body over its limit (64 KiB) with 413. The seller's terms are
    // small, so what is too large is the buyer's payment.
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(413, json!({ "error": "payload_too_large" })));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!verified.is_valid);
    assert_eq!(
        verified.invalid_reason.as_deref(),
        Some(r#"Facilitator verify failed (413): {"error":"payload_too_large"}"#)
    );
}

/// The `body` of the `Status` error for a `/verify` answered with `status` and `body`.
async fn status_excerpt(status: u16, reply: Reply) -> String {
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply { status, ..reply });
    let error = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap_err();
    match error {
        FacilitatorError::Status { body, .. } => body,
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_error_answer_is_cut_as_upstreams_response_excerpt_cuts_it() {
    // JSON as `JSON.stringify` writes it, text with its whitespace folded, 200 characters at
    // most with "..." in the last three, and a word for an empty answer.
    assert_eq!(
        status_excerpt(
            503,
            Reply::text(503, "{ \"error\" : \"rpc_unavailable\" }\n")
        )
        .await,
        r#"{"error":"rpc_unavailable"}"#
    );
    assert_eq!(
        status_excerpt(502, Reply::text(502, "  bad\n\n  gateway ")).await,
        "bad gateway"
    );
    assert_eq!(
        status_excerpt(500, Reply::text(500, &"x".repeat(300))).await,
        format!("{}...", "x".repeat(197))
    );
    assert_eq!(
        status_excerpt(500, Reply::text(500, "")).await,
        "<empty response>"
    );
}

/// What our facilitator answers when its settle budget ran out after the transaction was sent:
/// not final yet, with the transaction's hash, or with none when nothing was sent.
fn pending(transaction: &str) -> Reply {
    Reply::json(
        200,
        json!({
            "success": false,
            "errorReason": "settlement_pending",
            "payer": PAYER,
            "transaction": transaction,
            "network": "stellar:testnet"
        }),
    )
}

#[tokio::test]
async fn a_settlement_still_pending_is_asked_for_once_more() {
    // As upstream's `settleWithPendingRetry`: the facilitator answers the repeat with how the
    // transaction ended.
    let fake = FakeFacilitator::start().await;
    fake.settle_replies_once(pending(HASH));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(settled.success);
    assert_eq!(settled.transaction, HASH);
    assert_eq!(fake.paths(), ["/settle", "/settle"]);
}

#[tokio::test]
async fn a_settlement_pending_twice_is_asked_for_only_once_more() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(pending(HASH));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!settled.success);
    assert_eq!(settled.error_reason.as_deref(), Some("settlement_pending"));
    assert_eq!(fake.paths(), ["/settle", "/settle"]);
}

#[tokio::test]
async fn a_pending_settlement_without_a_transaction_is_not_asked_for_again() {
    // Upstream asks again only when a transaction was sent.
    let fake = FakeFacilitator::start().await;
    fake.settle_replies_once(pending(""));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!settled.success);
    assert_eq!(fake.paths(), ["/settle"]);
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let fake = FakeFacilitator::start().await;
    let target = format!("{}/verify", fake.url);
    let moved = Router::new().fallback(move || {
        let target = target.clone();
        async move { (StatusCode::TEMPORARY_REDIRECT, [(LOCATION, target)]) }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, moved).await.unwrap() });

    let error = Facilitator::new(&url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(
        matches!(error, FacilitatorError::Status { status: 307, .. }),
        "{error:?}"
    );
    // The buyer's payment did not go on to where the redirect pointed.
    assert_eq!(fake.paths(), Vec::<String>::new());
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

    assert!(
        matches!(&error, FacilitatorError::NotJson { body, .. } if body == "<html>gateway</html>"),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_settlement_without_a_transaction_is_an_error() {
    // Upstream's schema needs `transaction` and `network` as strings.
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(200, json!({ "success": true })));

    let error = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap_err();

    assert!(
        matches!(error, FacilitatorError::InvalidData { .. }),
        "{error:?}"
    );
}

#[tokio::test]
async fn the_buyer_gets_only_the_settlement_fields_upstreams_schema_has() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(
        200,
        json!({
            "success": true,
            "payer": PAYER,
            "transaction": HASH,
            "network": "stellar:testnet",
            "amount": "10000",
            "errorReason": null,
            "ledger": 123
        }),
    ));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    // The seller still reads what upstream's schema drops.
    assert_eq!(settled.other["ledger"], 123);
    let header = STANDARD.decode(settled.to_header()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&header).unwrap(),
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
async fn a_settlement_verdict_sent_with_an_error_status_is_a_refusal_as_upstream_builds_it() {
    // Upstream's `SettleError` path: never a success, and the buyer's `PAYMENT-RESPONSE` built
    // from the reason, or "unknown reason", and the fields the answer had.
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(
        500,
        json!({ "success": true, "transaction": HASH, "network": "stellar:testnet" }),
    ));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(!settled.success);
    let header = STANDARD.decode(settled.to_header()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&header).unwrap(),
        json!({
            "success": false,
            "errorReason": "unknown reason",
            "errorMessage": "unknown reason",
            "transaction": HASH,
            "network": "stellar:testnet"
        })
    );
}

#[tokio::test]
async fn a_settlement_verdict_sent_with_an_error_status_leaves_out_what_it_did_not_say() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies(Reply::json(
        500,
        json!({ "success": false, "errorReason": "settle_exact_stellar_timeout" }),
    ));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    let header = STANDARD.decode(settled.to_header()).unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&header).unwrap(),
        json!({
            "success": false,
            "errorReason": "settle_exact_stellar_timeout",
            "errorMessage": "settle_exact_stellar_timeout"
        })
    );
}

#[tokio::test]
async fn our_facilitators_own_code_reaches_the_seller() {
    // `apps/facilitator` puts its own code next to upstream's reason, e.g. for a channel account.
    let fake = FakeFacilitator::start().await;
    fake.verify_replies(Reply::json(
        200,
        json!({
            "isValid": false,
            "invalidReason": "invalid_exact_stellar_payload_channel_account",
            "extra": { "reason": "channel_account" }
        }),
    ));

    let verified = Facilitator::new(&fake.url)
        .unwrap()
        .verify(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert_eq!(
        verified.extra,
        json!({ "reason": "channel_account" }).as_object().cloned()
    );
}

#[tokio::test]
async fn a_pending_settlement_sent_with_an_error_status_is_asked_for_once_more_too() {
    let fake = FakeFacilitator::start().await;
    fake.settle_replies_once(Reply::json(
        503,
        json!({ "success": false, "errorReason": "settlement_pending", "transaction": HASH }),
    ));

    let settled = Facilitator::new(&fake.url)
        .unwrap()
        .settle(&payment(&terms()), &terms())
        .await
        .unwrap();

    assert!(settled.success);
    assert_eq!(fake.paths(), ["/settle", "/settle"]);
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
