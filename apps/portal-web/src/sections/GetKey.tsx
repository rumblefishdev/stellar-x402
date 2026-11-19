import { GetKeyLink, SectionHead } from "../components/SectionHead";

const STEPS = [
  {
    title: "Sign in with Discord",
    text: "One click, no form to fill. Your Discord account is your identity.",
  },
  {
    title: "Receive your key",
    text: "Generated instantly and always available from your dashboard.",
  },
  {
    title: "Settle your first payment",
    text: "Add the key to the facilitator client and charge your first request.",
  },
  {
    title: "Monitor usage",
    text: "Track settlements and limits from the dashboard, per network.",
  },
];

/** The card as the design draws it, with its placeholders: nothing here reads a key yet. */
function KeyCard() {
  return (
    <div className="card key-card">
      <div className="key-card-head">
        <span>My API key</span>
        <span className="key-state">Active</span>
      </div>
      <div className="key-field">
        <span>API key</span>
        <code>[YOUR_KEY_PREFIX]_••••••••••••••••</code>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
        <div className="tile inset">
          <code>stellar:pubnet</code>
          <span className="figure">[USED] / [QUOTA]</span>
          <span>settlements this month</span>
        </div>
        <div className="tile inset">
          <code>stellar:testnet</code>
          <span className="figure">Free</span>
          <span>within rate limits</span>
        </div>
      </div>
    </div>
  );
}

export function GetKey() {
  return (
    <section id="get-key" aria-labelledby="key-title" className="wrap section split">
      <div className="col" style={{ flex: "1 1 520px", gap: 24 }}>
        <SectionHead
          badge="Self-service portal"
          id="key-title"
          title="Get your API key in under a minute"
        >
          No emails. No waiting. No manual approval. One key works on mainnet and testnet.
        </SectionHead>
        <ol
          className="grid"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}
        >
          {STEPS.map((step, i) => (
            <li key={step.title} className="card">
              <span className="step-no">{String(i + 1).padStart(2, "0")}</span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
        <div>
          <GetKeyLink />
        </div>
      </div>
      <KeyCard />
    </section>
  );
}
