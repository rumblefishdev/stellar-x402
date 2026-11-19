import { Code } from "../components/Code";
import { SectionHead } from "../components/SectionHead";

const ROUTES = [
  ["GET", "/supported", "Schemes, networks, signers"],
  ["POST", "/verify", "Check a payment"],
  ["POST", "/settle", "Settle it on chain"],
  ["GET", "/discovery/resources", "Browse the Bazaar"],
  ["GET", "/discovery/search", "Plain-language search, ranked"],
  ["POST", "/mcp", "Search and pay from agents"],
] as const;

const RESPONSE = `// POST /settle — 200 OK
{
  "success": true,
  "transaction": "5f4fea5a…2c8914",
  "network": "stellar:pubnet",
  "payer": "G…BUYER"
}`;

const STATES = [
  { name: "stellar:pubnet", state: "Live", live: true },
  { name: "stellar:testnet", state: "Live · free", live: true },
  { name: "exact · upto", state: "upto in progress", live: false },
];

export function Endpoints() {
  return (
    <section id="endpoints" aria-labelledby="ep-title" className="wrap section">
      <SectionHead
        badge="Endpoints"
        id="ep-title"
        title="The standard x402 v2 surface. Plus discovery."
      >
        One host for both networks. The network comes from each payment.
      </SectionHead>
      <div className="code-row" style={{ alignItems: "flex-start" }}>
        <ul className="endpoints">
          {ROUTES.map(([method, path, what]) => (
            <li key={path}>
              <span className={method === "GET" ? "method get" : "method"}>{method}</span>
              <code>{path}</code>
              <span>{what}</span>
            </li>
          ))}
        </ul>
        <div className="col" style={{ flex: "1 1 420px", gap: 16 }}>
          <div className="code-card">
            <div className="code-tabs">
              <span style={{ padding: "2px 4px" }}>Example response</span>
            </div>
            <Code source={RESPONSE} language="json" />
          </div>
          <div
            className="grid"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
              gap: 12,
            }}
          >
            {STATES.map((item) => (
              <div key={item.name} className="tile">
                <code>{item.name}</code>
                <span className={item.live ? "state live" : "state"}>{item.state}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
