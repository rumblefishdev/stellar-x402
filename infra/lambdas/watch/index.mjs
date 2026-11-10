// The off-server check's handler (0027 decision 7). `make build` bundles it with signer-pool and
// stellar-sdk into dist/lambdas/watch/index.mjs (scripts/bundle-watch.mjs); the AWS SDK v3 comes
// with the Lambda Node.js runtime and stays out of the bundle. Only the client is built here: the
// logic and its tests are in src/watch/, and test/watch-bundle.test.ts loads the bundle itself.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { createHandler } from "../../src/watch/handler.js";

const client = new CloudWatchClient({});

export const handler = createHandler({
  env: process.env,
  publish: (input) => client.send(new PutMetricDataCommand(input)),
});
