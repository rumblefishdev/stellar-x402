import { SectionHead } from "../components/SectionHead";

const QUESTIONS: [question: string, answer: string][] = [
  [
    "What is an x402 facilitator?",
    "The service that checks an x402 payment and puts it on chain. Your API stays simple: it names a price and forwards the payment to /verify and /settle.",
  ],
  [
    "What is the Bazaar?",
    "A catalog of every API paid through our facilitator. Agents search it in plain language and get ranked results they can pay for right away. For sellers it is a distribution channel: agents find you on their own.",
  ],
  [
    "How do I get listed?",
    "Add the bazaar extension with a description to your route config. Your endpoint is listed after its first settled payment and shows up in /discovery/resources, /discovery/search and the MCP server.",
  ],
  [
    "How is the ranking decided?",
    "By relevance to the query and by the volume of successful purchases. New listings are visible from day one and climb as they sell. Placeholder descriptions rank lower.",
  ],
  [
    "How do I get an API key?",
    "Sign in with Discord and the key is issued immediately. The same key works on mainnet and testnet. Buyers never need one: the key belongs to the server that calls the facilitator.",
  ],
  [
    "Do buyers need XLM?",
    "No. The client signs only an authorization entry. We build the transaction and pay its network fee, so buyers hold just the payment token.",
  ],
  [
    "Do you hold my funds?",
    "Never. The payment moves directly from payer to payee inside the signed transfer. The facilitator only pays the fee.",
  ],
  [
    "Which tokens can I accept?",
    "Any SEP-41 token. USDC is the default; Stellar Asset Contracts and custom Soroban tokens settle too.",
  ],
  [
    "Mainnet or testnet?",
    "Both, on the same host. The network comes from each payment, so switching is one string. Testnet is free for development.",
  ],
  [
    "What does it cost on mainnet?",
    "[PRICING: plan or per-settlement fee]. Network fees are always included: we sponsor them, so buyers pay only the price you set.",
  ],
  [
    "Can I run it myself?",
    "Yes. The code is Apache-2.0 on GitHub, with deploy scripts, a runbook and a threat model.",
  ],
];

export function Faq() {
  return (
    <section
      id="faq"
      aria-labelledby="faq-title"
      className="wrap section split"
      style={{ alignItems: "flex-start" }}
    >
      <div className="col" style={{ flex: "1 1 300px" }}>
        <SectionHead badge="FAQ" id="faq-title" title="Common questions" />
      </div>
      <div className="faq">
        {QUESTIONS.map(([question, answer], i) => (
          <details key={question} open={i === 0}>
            <summary>{question}</summary>
            <p>{answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
