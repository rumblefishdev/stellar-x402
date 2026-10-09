import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Stores } from "../ports/index.js";

/** What the composition root hands to the HTTP adapter. Lanes add their services here. */
export interface AppDeps {
  config: Config;
  logger: Logger;
  stores: Stores;
}

const notImplemented: RequestHandler = (_req, res) => {
  res.status(501).json({ error: "not_implemented" });
};

/**
 * The inbound HTTP adapter (AD-13). The routes answer 501 until their tasks land: `/verify`
 * (0018), `/settle` (0009), `/supported` (0020) and `/discovery/resources` (0032). There is a
 * body size limit and no CORS anywhere (spine "HTTP hardening"); rate limits come in 0023.
 */
export function createApp({ config, logger }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: config.http.bodyLimitBytes }));

  app.post("/verify", notImplemented);
  app.post("/settle", notImplemented);
  app.get("/supported", notImplemented);
  app.get("/discovery/resources", notImplemented);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Express tells an error handler apart by its four parameters, so `_next` must stay.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    // body-parser marks the client's mistakes as `expose` (400 malformed JSON, 413 body over the
    // limit, 415 charset or encoding); anything else is ours.
    const status: number =
      error?.expose && error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) logger.error("http_error", { error });
    res.status(status).json({ error: status === 500 ? "internal_error" : "bad_request" });
  };
  app.use(onError);
  return app;
}
