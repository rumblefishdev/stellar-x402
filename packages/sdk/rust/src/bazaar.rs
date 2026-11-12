//! The `bazaar` extension: a route's request to be listed in a facilitator's catalog.
//!
//! The block is built as upstream's `declareDiscoveryExtension` and
//! `bazaarResourceServerExtension` build it (`@x402/extensions` 2.28.0), so a catalog that reads
//! theirs reads ours.

use serde_json::{json, Map, Value};

const JSON_SCHEMA: &str = "https://json-schema.org/draft/2020-12/schema";

/// How a paid route describes itself for the catalog: an example of its input, optionally the
/// input's JSON Schema and an example of its answer.
///
/// A facilitator that catalogs reads this from the route's own 402 answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Listing {
    input: Input,
    example: Value,
    input_schema: Value,
    output: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Input {
    /// GET, HEAD or DELETE: the input is the query string.
    Query,
    /// POST, PUT or PATCH with a JSON body.
    JsonBody,
}

impl Listing {
    /// A route that reads its input from the query string (GET, HEAD, DELETE). `example` is an
    /// object of query parameters that gets a real answer, such as `{"city": "Warsaw"}`.
    pub fn query(example: Value) -> Self {
        Self::new(Input::Query, example)
    }

    /// A route that reads a JSON body (POST, PUT, PATCH). `example` is a body that gets a real
    /// answer.
    pub fn json_body(example: Value) -> Self {
        Self::new(Input::JsonBody, example)
    }

    fn new(input: Input, example: Value) -> Self {
        Self {
            input,
            example,
            input_schema: json!({ "properties": {} }),
            output: None,
        }
    }

    /// The JSON Schema of the input: of the query parameters, or of the body.
    pub fn input_schema(mut self, schema: Value) -> Self {
        self.input_schema = schema;
        self
    }

    /// An example of the route's JSON answer.
    pub fn output(mut self, example: Value) -> Self {
        self.output = Some(example);
        self
    }

    /// The `bazaar` block for a request made with `method`.
    pub(crate) fn extension(&self, method: &str) -> Value {
        let mut input = json!({ "type": "http", "method": method });
        let mut properties = json!({
            "type": { "type": "string", "const": "http" },
            "method": { "type": "string", "enum": [method] },
        });
        let required = match self.input {
            Input::Query => {
                input["queryParams"] = self.example.clone();
                // Upstream spreads the schema over `{"type": "object"}`.
                let mut schema = Map::from_iter([("type".to_owned(), json!("object"))]);
                if let Value::Object(given) = &self.input_schema {
                    schema.extend(given.clone());
                }
                properties["queryParams"] = Value::Object(schema);
                json!(["type", "method"])
            }
            Input::JsonBody => {
                input["bodyType"] = json!("json");
                input["body"] = self.example.clone();
                properties["bodyType"] =
                    json!({ "type": "string", "enum": ["json", "form-data", "text"] });
                properties["body"] = self.input_schema.clone();
                json!(["type", "method", "bodyType", "body"])
            }
        };
        let mut info = json!({ "input": input });
        let mut schema_properties = json!({
            "input": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            }
        });
        if let Some(example) = &self.output {
            info["output"] = json!({ "type": "json", "example": example });
            schema_properties["output"] = json!({
                "type": "object",
                "properties": { "type": { "type": "string" }, "example": { "type": "object" } },
                "required": ["type"],
            });
        }
        json!({
            "info": info,
            "schema": {
                "$schema": JSON_SCHEMA,
                "type": "object",
                "properties": schema_properties,
                "required": ["input"],
            }
        })
    }
}
