import type { DiscoveryResource } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { searchFields } from "../src/index.js";

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
      host: "back-pvc-missions-bench.trycloudflare.com",
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
      parameters: "day port UN/LOCODE of the port",
      host: "sea.example",
    });
  });

  it("reads an HTTP listing's own input description too", () => {
    const http = listing({
      resource: "https://sea.example/tides",
      description: "Tide tables",
      extensions: { bazaar: { info: { input: { type: "http", description: "For a port" } } } },
    });
    expect(searchFields(http).description).toBe("Tide tables For a port");
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

  it("gives the same fields whatever order the listing's keys come in, as stored or not", () => {
    // jsonb, where the listing is stored, orders keys shorter first: `q` before `p00`…`p29`.
    const names = [...Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, "0")}`), "q"];
    const withInputs = (order: string[]) =>
      listing({
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "mcp",
                inputSchema: {
                  properties: Object.fromEntries(
                    order.map((n) => [n, { description: `about ${n}` }]),
                  ),
                },
              },
            },
          },
        },
      });
    const asSent = searchFields(withInputs(names));
    expect(searchFields(withInputs([...names].reverse()))).toEqual(asSent);
    expect(searchFields(withInputs(["q", ...names.slice(0, -1)]))).toEqual(asSent);
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
      host: "",
    });
  });

  it("reads a whole HTTP listing: service name, path words, tags, description, parameters", () => {
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
    expect(searchFields(sample)).toEqual({
      name: "Forecast v1 forecast",
      tags: "weather",
      description: "Daily forecast",
      parameters: "city City name",
      host: "a.example",
    });
  });

  it("reads the listing's host as the WHATWG URL parser does: lower case, no port, empty when it is no URL", () => {
    const hostOf = (resource: unknown) =>
      searchFields({ ...listing({}), resource } as unknown as DiscoveryResource).host;
    expect(hostOf("https://x.ngrok.io:8443/a")).toBe("x.ngrok.io");
    expect(hostOf("https://Seller.Example.com/a")).toBe("seller.example.com");
    expect(hostOf("not a url")).toBe("");
    expect(hostOf(undefined)).toBe("");
    expect(hostOf({ href: "https://seller.example/x" })).toBe("");
  });

  it("reads an MCP listing's host from its URL; the host changes none of the other four fields", () => {
    const tool = (resource: string) =>
      listing({ resource, type: "mcp", serviceName: "Sea levels", description: "Tide tables" });
    const { host, ...others } = searchFields(tool("https://Tools.Example:9000/mcp"));
    expect(host).toBe("tools.example");
    const { host: elsewhere, ...same } = searchFields(tool("https://other.example/mcp"));
    expect(elsewhere).toBe("other.example");
    expect(others).toEqual(same);
    expect(Object.keys(others).sort()).toEqual(["description", "name", "parameters", "tags"]);
  });
});
