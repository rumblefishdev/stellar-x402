import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { SEARCH_FIELDS_VERSION, searchFields } from "../src/index.js";

const listing = (fields: Partial<DiscoveryResource>): DiscoveryResource => ({
  resource: "https://seller.example/x",
  type: "http",
  x402Version: 2,
  accepts: [],
  lastUpdated: "2026-11-24T00:00:00.000Z",
  ...fields,
});

describe("searchFields", () => {
  it("reads testnet's weather listing, naming its one input once", () => {
    // The listing production served on 2026-11-23, trimmed to what search reads.
    const weather = listing({
      resource: "https://back-pvc-missions-bench.trycloudflare.com/weather",
      description: "Current temperature for a city",
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "GET", queryParams: { city: "Warsaw" } } },
          schema: {
            properties: {
              input: {
                properties: {
                  queryParams: { type: "object", properties: { city: { type: "string" } } },
                },
              },
            },
          },
        },
      },
    });
    expect(searchFields(weather)).toEqual({
      name: "weather",
      tags: "",
      description: "Current temperature for a city",
      parameters: "city",
    });
  });

  it("reads an MCP tool's name, its own description and its arguments", () => {
    const tool = listing({
      resource: "https://sea.example/mcp",
      type: "mcp",
      serviceName: "Sea levels",
      tags: ["ocean", "tides"],
      description: "Tide tables",
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "mcp",
              toolName: "get_tides",
              description: "High and low water for a port",
              inputSchema: {
                description: "A port and a day",
                properties: { port: { description: "UN/LOCODE of the port" }, day: {} },
              },
            },
          },
        },
      },
    });
    expect(searchFields(tool)).toEqual({
      name: "Sea levels get tides mcp",
      tags: "ocean tides",
      description: "Tide tables High and low water for a port A port and a day",
      parameters: "port UN/LOCODE of the port day",
    });
  });

  it("keeps an input's description from the schema when the listing's info has none", () => {
    const body = listing({
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "POST", body: { ticker: "XLM" } } },
          schema: {
            properties: {
              input: {
                properties: { body: { properties: { ticker: { description: "symbol" } } } },
              },
            },
          },
        },
      },
    });
    expect(searchFields(body).parameters).toBe("ticker symbol");
  });

  it("reads an HTTP listing's example values as no description", () => {
    const shop = listing({
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "POST",
              body: { product: { description: "Blue shirt size XL" } },
            },
          },
          schema: {
            properties: {
              input: {
                properties: {
                  body: { properties: { product: { description: "The product to buy" } } },
                },
              },
            },
          },
        },
      },
    });
    expect(searchFields(shop).parameters).toBe("product The product to buy");
  });

  it("caps the parameters at 40 entries, a name or a description each, of 300 characters", () => {
    const queryParams = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`p${i}`, { description: "d".repeat(400) }]),
    );
    const many = listing({
      extensions: {
        bazaar: { info: { input: { type: "mcp", inputSchema: { properties: queryParams } } } },
      },
    });
    const words = searchFields(many).parameters.split(" ");
    expect(words).toHaveLength(40);
    expect(words[1]).toBe("d".repeat(300));
  });

  it("adds nothing for fields of an unexpected shape", () => {
    const odd = {
      ...listing({ description: "weather" }),
      resource: 1,
      serviceName: 2,
      tags: "x",
      extensions: { bazaar: { info: { input: "x" }, schema: { properties: { input: [] } } } },
    } as unknown as DiscoveryResource;
    expect(searchFields(odd)).toEqual({
      name: "",
      tags: "",
      description: "weather",
      parameters: "",
    });
  });

  // Cards built by another version are rewritten only when the version changes, so an output
  // pinned here changes together with the version beside it.
  it("pins its output to the rules version", () => {
    const sample = listing({
      resource: "https://a.example/v1/forecast?city=x",
      serviceName: "Forecast",
      tags: ["weather"],
      description: "Daily forecast",
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "GET", queryParams: { city: "Gdansk" } } },
          schema: {
            properties: {
              input: {
                properties: {
                  queryParams: { properties: { city: { description: "City name" } } },
                },
              },
            },
          },
        },
      },
    });
    expect({ version: SEARCH_FIELDS_VERSION, fields: searchFields(sample) }).toEqual({
      version: 1,
      fields: {
        name: "Forecast v1 forecast",
        tags: "weather",
        description: "Daily forecast",
        parameters: "city City name",
      },
    });
  });
});
