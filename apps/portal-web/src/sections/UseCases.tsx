import { SectionHead } from "../components/SectionHead";

const CASES = [
  {
    title: "Data APIs",
    text: "Sell prices, analytics or indexed chain data per call, with no keys or subscriptions to manage.",
  },
  {
    title: "AI agent tools",
    text: "Let agents pay for search, scraping or inference as they go, within the budget their owner set.",
  },
  {
    title: "Metered services",
    coming: true,
    text: "With the upto scheme, authorize a ceiling and charge the actual usage after the work is done.",
  },
  {
    title: "Content paywalls",
    text: "Unlock an article, a file or a video for a fraction of a cent, settled in about five seconds.",
  },
  {
    title: "MCP servers",
    text: "Put a price on MCP tools and list them in the Bazaar next to HTTP endpoints.",
  },
  {
    title: "Machine-to-machine",
    text: "Services that pay each other per request, with every payment verifiable on chain.",
  },
];

export function UseCases() {
  return (
    <section aria-labelledby="use-title" className="wrap section">
      <SectionHead badge="Use cases" id="use-title" title="What can you charge for?">
        Anything an agent calls over HTTP, priced per request.
      </SectionHead>
      <ol className="use-cases">
        {CASES.map((item, i) => (
          <li key={item.title} className="numbered">
            <span>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h3>
                {item.title}
                {item.coming && (
                  <>
                    {" "}
                    <span className="pill">Coming</span>
                  </>
                )}
              </h3>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
