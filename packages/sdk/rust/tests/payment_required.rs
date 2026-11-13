//! The 402 answer: what a seller sends for a request without a payment.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use stellar_x402::{Network, PaymentRequired, PaymentRequirements, Price, ResourceInfo, Supported};

const PAY_TO: &str = "GDPBXAO27ZR2M2TM6DVG5IVJ5D3C6DLHPE5FXYXKAUTM6XKPIACDAIH3";

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Our testnet facilitator's `/supported`, as it answered on 2026-11-12.
fn supported() -> Supported {
    serde_json::from_value(fixture("supported.json")).unwrap()
}

/// The 402 of the route `examples/http-api` charges for, without its `bazaar` block.
fn weather_402() -> PaymentRequired {
    let terms = PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::usdc("0.001").unwrap())
        .unwrap()
        .with_supported(&supported());
    let resource = ResourceInfo::new("http://localhost:4021/weather?city=Warsaw")
        .description("Current temperature for a city")
        .mime_type("application/json");
    PaymentRequired::new(resource, vec![terms])
}

#[test]
fn matches_what_upstreams_middleware_sends() {
    // Captured from `examples/http-api` (`@x402/express` 2.28.0) for the same route and seller;
    // 2.31.0 sends the same, by the parity run of 0136.
    let mut upstream = fixture("payment-required-upstream.json");
    upstream.as_object_mut().unwrap().remove("extensions");

    assert_eq!(serde_json::to_value(weather_402()).unwrap(), upstream);
}

#[test]
fn a_resource_without_a_description_or_a_media_type_names_both_empty() {
    // Upstream's middleware writes `description: routeConfig.description || ""`, and the same
    // for `mimeType`.
    let resource = ResourceInfo::new("http://localhost:4021/weather");

    assert_eq!(
        serde_json::to_value(resource).unwrap(),
        json!({ "url": "http://localhost:4021/weather", "description": "", "mimeType": "" })
    );
}

#[test]
fn header_value_is_the_answer_as_base64_json() {
    let required = weather_402();

    let decoded: Value =
        serde_json::from_slice(&STANDARD.decode(required.to_header()).unwrap()).unwrap();

    assert_eq!(decoded, serde_json::to_value(&required).unwrap());
}

#[test]
fn terms_on_pubnet_name_pubnets_usdc() {
    let terms =
        PaymentRequirements::exact(Network::Pubnet, PAY_TO, Price::usdc("1").unwrap()).unwrap();

    let json = serde_json::to_value(terms).unwrap();

    assert_eq!(json["network"], "stellar:pubnet");
    assert_eq!(
        json["asset"],
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
    );
    assert_eq!(json["amount"], "10000000");
}

#[test]
fn terms_in_another_token_carry_its_contract_and_base_units() {
    let token = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

    let terms =
        PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::token(token, 250).unwrap())
            .unwrap();

    let json = serde_json::to_value(terms).unwrap();
    assert_eq!(json["asset"], token);
    assert_eq!(json["amount"], "250");
}

#[test]
fn terms_get_no_extra_when_the_facilitator_does_not_support_their_network() {
    // The fixture's facilitator supports testnet only.
    let terms = PaymentRequirements::exact(Network::Pubnet, PAY_TO, Price::usdc("1").unwrap())
        .unwrap()
        .with_supported(&supported());

    assert_eq!(serde_json::to_value(terms).unwrap().get("extra"), None);
}

#[test]
fn terms_are_not_supported_by_a_facilitator_with_another_version_or_scheme_on_their_network() {
    // A facilitator that speaks `exact` only in x402 v1, and v2 only for `upto`: every `/verify`
    // of the seller's v2 `exact` terms would fail, so `charge()` must refuse them at start.
    let other: Supported = serde_json::from_value(json!({
        "kinds": [
            { "x402Version": 1, "scheme": "exact", "network": "stellar:testnet", "extra": { "areFeesSponsored": true } },
            { "x402Version": 2, "scheme": "upto", "network": "stellar:testnet", "extra": { "areFeesSponsored": true } }
        ]
    }))
    .unwrap();
    let terms =
        PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::usdc("1").unwrap()).unwrap();

    assert!(!other.supports(&terms));
    let terms = terms.with_supported(&other);
    assert_eq!(serde_json::to_value(terms).unwrap().get("extra"), None);
}

#[test]
fn only_a_boolean_fee_sponsorship_is_copied_from_supported() {
    let odd: Supported = serde_json::from_value(json!({
        "kinds": [{
            "x402Version": 2,
            "scheme": "exact",
            "network": "stellar:testnet",
            "extra": { "areFeesSponsored": "yes", "other": 1 }
        }]
    }))
    .unwrap();

    let terms = PaymentRequirements::exact(Network::Testnet, PAY_TO, Price::usdc("1").unwrap())
        .unwrap()
        .with_supported(&odd);

    assert_eq!(serde_json::to_value(terms).unwrap().get("extra"), None);
}
