import type { ReactNode } from "react";
import { SectionHead } from "../components/SectionHead";

/** What a settlement-only facilitator has: `true`, `false`, or words. Ours has every row. */
const ROWS: [feature: string, others: boolean | string][] = [
  ["Verify and settle x402 payments", true],
  ["Sponsored network fees", true],
  ["Catalog of APIs that actually get paid", false],
  ["Ranking by volume of successful purchases", false],
  ["Plain-language search for agents", false],
  ["MCP server: search and pay from the agent loop", false],
  ["Open source, self-hostable", "Varies"],
];

const yes = (
  <span aria-label="Yes" className="yes">
    ✓
  </span>
);
const no = (
  <span aria-label="No" className="no">
    —
  </span>
);

const icon = (paths: ReactNode) => (
  <svg
    aria-hidden="true"
    width="28"
    height="28"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#fdda24"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {paths}
  </svg>
);

const REST = [
  {
    title: "Fees sponsored",
    text: "Buyers hold only the payment asset. We pay every network fee, so an agent never needs XLM to pay you.",
    icon: icon(
      <>
        <path d="M12 2v20" />
        <path d="M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </>,
    ),
  },
  {
    title: "Any SEP-41 token",
    text: "USDC by default, but any SEP-41 token settles: Stellar Asset Contracts and custom Soroban tokens alike.",
    icon: icon(
      <>
        <circle cx="8" cy="8" r="5" />
        <circle cx="16" cy="16" r="5" />
      </>,
    ),
  },
  {
    title: "Non-custodial",
    text: "Funds move directly from payer to payee inside the signed transfer. The facilitator never holds your money.",
    icon: icon(
      <>
        <path d="M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z" />
        <path d="M9 12l2 2 4-4" />
      </>,
    ),
  },
  {
    title: "Built for throughput",
    text: "A pool of channel accounts, each with its own sequence number, settles payments in parallel instead of in a queue.",
    icon: icon(
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h16" />
        <path d="M8 4v4" />
        <path d="M14 10v4" />
        <path d="M10 16v4" />
      </>,
    ),
  },
  {
    title: "Standard x402 v2",
    text: "Built on the official @x402/stellar package. Unmodified canonical x402 clients and middleware work as they are.",
    icon: icon(<path d="M4 12l5 5L20 6" />),
  },
  {
    title: "Open source",
    text: "Apache-2.0, permissive dependencies only. Use our hosted endpoint on mainnet and testnet, or run your own.",
    icon: icon(
      <>
        <path d="M8 8l-5 4 5 4" />
        <path d="M16 8l5 4-5 4" />
        <path d="M14 4l-4 16" />
      </>,
    ),
  },
];

export function Why() {
  return (
    <section aria-labelledby="why-title" className="wrap section">
      <SectionHead
        badge="Why Rumble Fish x402"
        id="why-title"
        title="Every facilitator settles. Ours also sells."
      >
        Verify and settle are table stakes. The Bazaar is what brings you buyers.
      </SectionHead>
      <div className="table-card">
        <table className="compare">
          <thead>
            <tr>
              <th scope="col">Feature</th>
              <th scope="col">Settlement-only facilitator</th>
              <th scope="col" className="ours">
                Rumble Fish x402
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([feature, others]) => (
              <tr key={feature}>
                <th scope="row">{feature}</th>
                <td>{typeof others === "string" ? others : others ? yes : no}</td>
                <td className="ours">{yes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note" style={{ fontSize: 15 }}>
        And the rest of what a paid API on Stellar needs:
      </p>
      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}
      >
        {REST.map((item) => (
          <article key={item.title} className="card roomy">
            {item.icon}
            <h3>{item.title}</h3>
            <p>{item.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
