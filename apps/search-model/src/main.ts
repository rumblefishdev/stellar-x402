import { startServer } from "./server.js";

// The image sets both; a missing one stops the container at start, not at the first request.
const modelDir = process.env.MODEL_DIR;
const port = Number(process.env.PORT);
if (!modelDir || !Number.isInteger(port)) throw new Error("MODEL_DIR and PORT must be set");
const server = await startServer({ modelDir, port });
console.log(JSON.stringify({ event: "search_model_listening", port }));
process.on("SIGTERM", () => void server.close().then(() => process.exit(0)));
