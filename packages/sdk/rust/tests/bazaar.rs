//! The `bazaar` block of the 402 answer: how a route asks to be listed in a facilitator's catalog.

mod support;

use serde_json::{json, Value};
use stellar_x402::{Listing, PaymentRequired, ResourceInfo};
use support::{fixture, terms};

fn answer(listing: &Listing, method: &str) -> Value {
    let resource = ResourceInfo::new("http://localhost:4021/weather?city=Warsaw")
        .description("Current temperature for a city")
        .mime_type("application/json");
    let required = PaymentRequired::new(resource, vec![terms()]).with_listing(listing, method);
    serde_json::to_value(required).unwrap()
}

#[test]
fn a_listed_get_route_matches_what_upstreams_middleware_sends() {
    // The whole 402 of `examples/http-api` (`@x402/express` and `@x402/extensions` 2.28.0;
    // 2.31.0 sends the same, by the parity run of 0136).
    let listing = Listing::query(json!({ "city": "Warsaw" }))
        .input_schema(
            json!({ "properties": { "city": { "type": "string" } }, "required": ["city"] }),
        )
        .output(json!({ "city": "Warsaw", "tempC": 14 }));

    assert_eq!(
        answer(&listing, "GET"),
        fixture("payment-required-upstream.json")
    );
}

#[test]
fn the_listing_names_the_method_of_the_request_it_answers() {
    let listing = Listing::query(json!({}));

    let bazaar = &answer(&listing, "DELETE")["extensions"]["bazaar"];

    assert_eq!(bazaar["info"]["input"]["method"], "DELETE");
    assert_eq!(
        bazaar["schema"]["properties"]["input"]["properties"]["method"]["enum"],
        json!(["DELETE"])
    );
}

#[test]
fn a_method_the_input_cannot_take_is_named_as_the_first_one_it_can() {
    // `@x402/extensions` 2.31's `resolveDeclaredMethod`: GET, HEAD, DELETE for a query; POST,
    // PUT, PATCH for a body.
    let query = &answer(&Listing::query(json!({})), "POST")["extensions"]["bazaar"];
    let body = &answer(&Listing::json_body(json!({})), "GET")["extensions"]["bazaar"];

    assert_eq!(query["info"]["input"]["method"], "GET");
    assert_eq!(
        query["schema"]["properties"]["input"]["properties"]["method"]["enum"],
        json!(["GET"])
    );
    assert_eq!(body["info"]["input"]["method"], "POST");
}

#[test]
fn a_listing_without_an_output_example_declares_no_output() {
    let bazaar =
        &answer(&Listing::query(json!({ "city": "Warsaw" })), "GET")["extensions"]["bazaar"];

    assert_eq!(bazaar["info"].get("output"), None);
    assert_eq!(bazaar["schema"]["properties"].get("output"), None);
}

#[test]
fn a_listing_without_an_input_schema_accepts_any_query() {
    let bazaar =
        &answer(&Listing::query(json!({ "city": "Warsaw" })), "GET")["extensions"]["bazaar"];

    assert_eq!(
        bazaar["schema"]["properties"]["input"]["properties"]["queryParams"],
        json!({ "type": "object", "properties": {} })
    );
}

#[test]
fn a_listed_json_body_route_is_declared_as_upstream_declares_it() {
    // Written from `createBodyDiscoveryExtension` and `bazaarResourceServerExtension` of
    // `@x402/extensions` 2.31.0, unchanged there since 2.28.0.
    let schema = json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] });
    let listing = Listing::json_body(json!({ "text": "hello" }))
        .input_schema(schema.clone())
        .output(json!({ "words": 1 }));

    assert_eq!(
        answer(&listing, "POST")["extensions"]["bazaar"],
        json!({
            "info": {
                "input": { "type": "http", "method": "POST", "bodyType": "json", "body": { "text": "hello" } },
                "output": { "type": "json", "example": { "words": 1 } }
            },
            "schema": {
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "type": "object",
                "properties": {
                    "input": {
                        "type": "object",
                        "properties": {
                            "type": { "type": "string", "const": "http" },
                            "method": { "type": "string", "enum": ["POST"] },
                            "bodyType": { "type": "string", "enum": ["json", "form-data", "text"] },
                            "body": schema
                        },
                        "required": ["type", "method", "bodyType", "body"],
                        "additionalProperties": false
                    },
                    "output": {
                        "type": "object",
                        "properties": { "type": { "type": "string" }, "example": { "type": "object" } },
                        "required": ["type"]
                    }
                },
                "required": ["input"]
            }
        })
    );
}

#[test]
fn an_answer_without_a_listing_has_no_extensions() {
    let resource = ResourceInfo::new("http://localhost:4021/weather");
    let required = PaymentRequired::new(resource, vec![terms()]);

    assert_eq!(
        serde_json::to_value(required).unwrap().get("extensions"),
        None
    );
}
