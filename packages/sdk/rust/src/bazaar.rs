//! The `bazaar` extension: a route's request to be listed in a facilitator's catalog.
//!
//! The block is built as upstream's `declareDiscoveryExtension` and
//! `bazaarResourceServerExtension` build it (`@x402/extensions` 2.31.0), so a catalog that reads
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

    /// The method a listing names for a request made with `method`: that one when the input can
    /// take it, else the first one it can, as `@x402/extensions`' `resolveDeclaredMethod`.
    fn declared_method(&self, method: &str) -> String {
        let allowed: &[&str] = match self.input {
            Input::Query => &["GET", "HEAD", "DELETE"],
            Input::JsonBody => &["POST", "PUT", "PATCH"],
        };
        let method = method.to_ascii_uppercase();
        match allowed.contains(&method.as_str()) {
            true => method,
            false => allowed[0].to_owned(),
        }
    }

    /// The `bazaar` block for a request made with `method`. `route` is the router's pattern and
    /// the request's path: a route with a path parameter is listed once, by its template.
    pub(crate) fn extension(&self, method: &str, route: Option<(&str, &str)>) -> Value {
        let method = self.declared_method(method);
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
        let mut block = json!({
            "info": info,
            "schema": {
                "$schema": JSON_SCHEMA,
                "type": "object",
                "properties": schema_properties,
                "required": ["input"],
            }
        });
        // As `bazaarResourceServerExtension` adds them for a route with a parameter.
        if let Some((template, params)) = route.and_then(|(pattern, path)| template(pattern, path))
        {
            block["routeTemplate"] = json!(template);
            block["info"]["input"]["pathParams"] = Value::Object(params);
            block["schema"]["properties"]["input"]["properties"]["pathParams"] =
                json!({ "type": "object" });
        }
        block
    }
}

/// axum's `pattern` as a route template (`/assets/{id}/price` is `/assets/:id/price`) and the
/// parameters' values as `path` wrote them, not percent-decoded.
///
/// `None` wherever our catalog would drop the template (`packages/bazaar/src/url.ts`,
/// `matchRouteTemplate`): no parameter, a wildcard, a segment that mixes text and a parameter, a
/// name or a static segment outside its grammar. The route is then listed by its URL, as before.
fn template(pattern: &str, path: &str) -> Option<(String, Map<String, Value>)> {
    let word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let (wanted, actual): (Vec<_>, Vec<_>) =
        (pattern.split('/').collect(), path.split('/').collect());
    if wanted.len() != actual.len() || !pattern.starts_with('/') {
        return None;
    }
    let mut template = String::new();
    let mut params = Map::new();
    let mut has_static = false;
    for (wanted, actual) in wanted.into_iter().zip(actual).skip(1) {
        template.push('/');
        match wanted
            .strip_prefix('{')
            .and_then(|name| name.strip_suffix('}'))
        {
            Some(name) => {
                let named = name.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
                    && name.chars().all(word);
                if !named || actual.is_empty() {
                    return None;
                }
                template.push(':');
                template.push_str(name);
                params.insert(name.to_owned(), json!(actual));
            }
            None => {
                let plain = !wanted.is_empty()
                    && wanted
                        .chars()
                        .all(|c| word(c) || matches!(c, '.' | '~' | '-'));
                if !plain || wanted == "." || wanted == ".." {
                    return None;
                }
                template.push_str(wanted);
                has_static = true;
            }
        }
    }
    (has_static && !params.is_empty()).then_some((template, params))
}

#[cfg(test)]
mod tests {
    use super::template;

    #[test]
    fn a_pattern_becomes_a_template_only_when_the_catalog_would_keep_it() {
        let named = |pattern, path| template(pattern, path).map(|(template, _)| template);
        assert_eq!(
            named("/x402/v1/assets/{id}/price", "/x402/v1/assets/native/price").as_deref(),
            Some("/x402/v1/assets/:id/price")
        );
        for (pattern, path) in [
            ("/weather", "/weather"),
            ("/{id}", "/1"),
            ("/files/{*rest}", "/files/a/b"),
            ("/a/{id}.json", "/a/1.json"),
            ("/a/{id}", "/a/1/2"),
            ("/a/{id}/b", "/a//b"),
            ("/a/{my-id}", "/a/1"),
            ("/a b/{id}", "/a b/1"),
            ("/../{id}", "/../1"),
            ("/a/{id}/", "/a/1/"),
        ] {
            assert_eq!(named(pattern, path), None, "{pattern}");
        }
    }
}
