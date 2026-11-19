import { GetKeyLink, SectionHead } from "../components/SectionHead";

const STEPS = [
  {
    title: "Listed on your first sale",
    text: "The first settled payment that carries the bazaar extension adds your endpoint to the catalog, with the description from your route config. No forms, no review queue.",
  },
  {
    title: "Ranked by successful purchases",
    text: "Ranking follows the volume of successful purchases: the more your API sells, the higher it ranks. Only settled payments count, so a listing can’t be faked.",
  },
  {
    title: "Found in plain language",
    text: "Agents describe what they need in their own words, through /discovery/search or our MCP server. The Bazaar returns the best-matching paid APIs, ranked and ready to pay for in the same loop.",
  },
];

export function Bazaar() {
  return (
    <section id="bazaar" aria-labelledby="bazaar-title" className="wrap section">
      <SectionHead
        badge="Bazaar"
        id="bazaar-title"
        title="Your next customer is an agent. Let it find you."
      >
        Agents don’t google. They ask. The Bazaar answers with the APIs agents already pay for, so
        your endpoint is found, chosen and paid with no human in the loop.
      </SectionHead>
      <ol
        className="grid"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))" }}
      >
        {STEPS.map((step, i) => (
          <li key={step.title} className="card numbered" style={{ flexDirection: "row" }}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="card accent callout">
        <div>
          <h3>Marketing that runs itself</h3>
          <p>
            Every sale is also a listing and a vote. The more agents pay you, the higher you rank,
            and the more agents find you.
          </p>
        </div>
        <GetKeyLink />
      </div>
    </section>
  );
}
