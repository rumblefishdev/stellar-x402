import { describe, expect, it } from "vitest";
import { CATALOG_KEY_VERSION, normalize, validate } from "../src/index.js";
import { mcpInfo, payload, requirements } from "./fixtures.js";

function entry(p = payload(), req = requirements) {
  const result = validate(p, req);
  if (!result?.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return normalize(result, req);
}

describe("normalize", () => {
  it("builds the upstream DiscoveryResource shape with the paid requirement", () => {
    expect(entry()).toEqual({
      key: {
        network: "stellar:testnet",
        payTo: requirements.payTo,
        method: "GET",
        resourceUrl: "https://api.example.com/users/42",
      },
      keyVersion: CATALOG_KEY_VERSION,
      resource: {
        resource: "https://api.example.com/users/42",
        type: "http",
        x402Version: 2,
        accepts: [requirements],
        description: "User profile",
        mimeType: "application/json",
        extensions: {
          bazaar: { info: { input: { type: "http", method: "GET" } }, schema: { type: "object" } },
        },
      },
    });
  });

  it("gives /users/42 and /users/7 one key and one shown URL", () => {
    const a = entry(
      payload({ url: "https://api.example.com/users/42", routeTemplate: "/users/:userId" }),
    );
    const b = entry(
      payload({ url: "https://api.example.com/users/7", routeTemplate: "/users/:userId" }),
    );
    expect(a.key).toEqual(b.key);
    expect(a.key.resourceUrl).toBe("https://api.example.com/users/:");
    expect(a.resource.resource).toBe("https://api.example.com/users/:userId");
    expect(a.resource).toEqual(b.resource);
  });

  it("stores the concrete path when the template is discarded (G4)", () => {
    const e = entry(payload({ url: "https://x.com/cheap", routeTemplate: "/premium" }));
    expect(e.key.resourceUrl).toBe("https://x.com/cheap");
    expect(e.resource.resource).toBe("https://x.com/cheap");
    expect(e.resource.extensions?.bazaar).not.toHaveProperty("routeTemplate");
  });

  it("takes network and payTo from the verified requirements", () => {
    const e = entry(payload(), { ...requirements, payTo: "GVERIFIED" });
    expect(e.key.payTo).toBe("GVERIFIED");
    expect(e.key.network).toBe("stellar:testnet");
  });

  it("keys mcp by tool name", () => {
    const e = entry(payload({ url: "https://x.com/mcp", info: mcpInfo }));
    expect(e.key).toMatchObject({ method: "get_weather", resourceUrl: "https://x.com/mcp" });
    expect(e.resource.type).toBe("mcp");
  });
});
