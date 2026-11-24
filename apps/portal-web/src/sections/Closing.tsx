import { DocsLink, GetKeyLink, SectionHead } from "../components/SectionHead";

const LIMITS = [
  "Every facilitator call carries your key; buyers never need one",
  "Rate limits per key on /verify, /settle and /discovery, with a clear 429",
  "Spend budgets per payer, recipient and asset stop fee-drain abuse",
  "Network fees sponsored on mainnet and testnet alike",
];

export function FairAccess() {
  return (
    <section aria-labelledby="access-title" className="wrap section split">
      <div className="col" style={{ flex: "1 1 440px", gap: 16 }}>
        <SectionHead badge="Fair access" id="access-title" title="Reliable on both networks">
          Limits per key and spend budgets keep sponsored fees safe and settlement fast for
          everyone.
        </SectionHead>
        <ul className="arrows">
          {LIMITS.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ul>
      </div>
      <div
        className="grid"
        style={{
          flex: "1 1 520px",
          minWidth: 0,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
        }}
      >
        <div className="card stat">
          <span>Testnet</span>
          <span className="figure accent">$0</span>
          <span>Free, fees sponsored</span>
        </div>
        <div className="card stat">
          <span>Mainnet</span>
          <span className="figure">[PRICE]</span>
          <span>[per settlement / month]</span>
        </div>
        <div className="card stat">
          <span>Settlement</span>
          <span className="figure">~5 s</span>
          <span>One Stellar ledger close</span>
        </div>
      </div>
    </section>
  );
}

export function Family() {
  return (
    <section aria-labelledby="family-title" className="wrap section">
      <SectionHead
        badge="Built by Rumble Fish"
        id="family-title"
        title="Part of the Soroban Scan family"
      >
        We build Stellar infrastructure that developers use every day. The x402 facilitator is
        funded by the Stellar Community Fund and maintained beyond the grant, alongside our other
        public tools.
      </SectionHead>
      <div
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}
      >
        <a className="card roomy" href="https://sorobanscan.com/">
          <h3>Soroban Scan</h3>
          <p>
            Explore Soroban contracts, transactions and events. Every x402 settlement links here.
          </p>
          <span className="more">Open explorer →</span>
        </a>
        <a className="card roomy" href="https://sorobanscan.com/api/prices-api/">
          <h3>Prices API</h3>
          <p>Real-time and historical token prices across SDEX and four Soroban AMMs.</p>
          <span className="more">Get API key →</span>
        </a>
        <div className="card roomy accent">
          <h3>x402 Facilitator</h3>
          <p style={{ color: "var(--lead)" }}>Verify, settle and discover paid APIs on Stellar.</p>
          <span className="here">You are here</span>
        </div>
      </div>
      <p className="note">
        Built under the Stellar Community Fund RFP for an x402 facilitator with Bazaar discovery.
      </p>
    </section>
  );
}

export function Closing() {
  return (
    <section aria-labelledby="cta-title" className="wrap closing">
      <div>
        <h2 id="cta-title">Get found by agents. Get paid on Stellar.</h2>
        <p className="lead">
          Get your key, add the bazaar extension, and your first sale puts your API in front of
          every agent that searches. Your buyers need no key and no XLM.
        </p>
        <div className="btn-row">
          <GetKeyLink />
          <DocsLink />
        </div>
      </div>
    </section>
  );
}
