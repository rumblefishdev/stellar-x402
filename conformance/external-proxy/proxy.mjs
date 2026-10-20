// The facilitator the x402 e2e suite starts, standing in for the one under test (ADR 0009). It
// answers the suite's /health and /close itself and forwards the payment calls to
// GATE_FACILITATOR_URL unchanged. The suite copies only this folder into its checkout, so it uses
// Node built-ins only.
import { createServer } from "node:http";
import { text } from "node:stream/consumers";

const target = process.env.GATE_FACILITATOR_URL;
const port = Number(process.env.PORT);
if (!target || !port) {
  console.error("GATE_FACILITATOR_URL and PORT must be set");
  process.exit(1);
}

const forwarded = new Set(["POST /verify", "POST /settle", "GET /supported"]);

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  return res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const route = `${req.method} ${req.url}`;
  if (route === "GET /health") return send(res, 200, { status: "ok" });
  if (route === "POST /close") {
    send(res, 200, { message: "Proxy shutting down" });
    return res.on("finish", () => process.exit(0));
  }
  if (!forwarded.has(route)) return send(res, 404, { error: "not_found" });

  const started = Date.now();
  try {
    const body = req.method === "POST" ? await text(req) : undefined;
    const answer = await fetch(`${target}${req.url}`, {
      method: req.method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body,
    });
    const answerBody = await answer.text();
    console.log(`${route} -> ${answer.status} in ${Date.now() - started} ms`);
    const type = answer.headers.get("content-type");
    res.writeHead(answer.status, type ? { "content-type": type } : {});
    res.end(answerBody);
  } catch (error) {
    // The suite sees a 502; the cause goes to stderr.
    console.error(`${route} failed after ${Date.now() - started} ms:`, error);
    send(res, 502, { error: "facilitator_unreachable" });
  }
});

// Only this machine: the suite and its servers call http://localhost:<PORT>.
server.listen(port, "localhost", () => {
  console.log(`Facilitator listening on port ${port}, forwarding to ${target}`);
});
