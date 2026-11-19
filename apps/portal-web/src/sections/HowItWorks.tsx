import { Fragment } from "react";
import { SectionHead } from "../components/SectionHead";

const FLOW = [
  { label: "GET" },
  { label: "402 Payment Required", className: "due" },
  { label: "Signed auth entry" },
  { label: "/verify + /settle" },
  { label: "200 OK + data", className: "done" },
];

const STEPS = [
  {
    title: "Request",
    text: "A client or AI agent calls your endpoint and gets 402 with the price, asset and recipient.",
  },
  {
    title: "Sign",
    text: "The client signs one Soroban authorization entry for the transfer. Not a full transaction, and no XLM needed.",
  },
  {
    title: "Verify",
    text: "Your server forwards it to /verify. Signature, auth scope and simulated balance changes are checked.",
  },
  {
    title: "Settle",
    text: "/settle checks again, wraps the entry in a transaction from our channel-account pool, pays the fee and submits.",
  },
  {
    title: "Deliver",
    text: "You get the transaction hash and return the data. The payment is verifiable in Soroban Scan.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="wrap section">
      <SectionHead
        badge="How it works"
        id="how-title"
        title="One HTTP round trip. Settled on Stellar in seconds."
      >
        Your API names a price. The agent signs. We verify, pay the fee and settle. Funds go
        straight from payer to payee.
      </SectionHead>
      <div role="list" aria-label="Payment flow" className="flow">
        {FLOW.map((part, i) => (
          <Fragment key={part.label}>
            {i > 0 && <span aria-hidden="true">→</span>}
            <span role="listitem" className={part.className}>
              {part.label}
            </span>
          </Fragment>
        ))}
      </div>
      <ol
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))" }}
      >
        {STEPS.map((step, i) => (
          <li key={step.title} className="card">
            <span className={i === STEPS.length - 1 ? "step-no ok" : "step-no"}>
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
