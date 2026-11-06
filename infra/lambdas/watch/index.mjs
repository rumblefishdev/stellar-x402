// The off-server check's handler (0027 decision 7). `make build` bundles it with signer-pool and
// stellar-sdk into dist/lambdas/watch/index.mjs (scripts/bundle-watch.mjs); the AWS SDK v3 comes
// with the Lambda Node.js runtime and stays out of the bundle. The logic and its tests are in
// src/watch/.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { rpc } from "@stellar/stellar-sdk";
import { runBalance } from "../../src/watch/balance.js";
import { TARGETS_ENV, parseTargets } from "../../src/watch/targets.js";

const client = new CloudWatchClient({});
const targets = parseTargets(process.env[TARGETS_ENV]);

/** @param {{ scheduledTime?: string } | undefined} event the schedule's input */
export const handler = async (event) => {
  const scheduled = event?.scheduledTime ? new Date(event.scheduledTime) : undefined;
  const at = scheduled && !Number.isNaN(scheduled.getTime()) ? scheduled : new Date();
  await runBalance({
    targets,
    rpcFor: (url) => new rpc.Server(url),
    publish: (input) => client.send(new PutMetricDataCommand(input)),
    log: (line) => console.log(JSON.stringify(line)),
    at,
  });
};
