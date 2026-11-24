// The uptime probe's handler. The AWS SDK v3 comes with the Lambda Node.js runtime, so nothing is
// bundled (as the explorer's galexie-protocol-watch); the logic and its tests are in probe.mjs.
// Each function of the Uptime stack runs this code on its own target, from its environment.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { runProbe, targetFromEnv } from "./probe.mjs";

const client = new CloudWatchClient({});

export const handler = async () =>
  runProbe({
    ...targetFromEnv(process.env),
    fetch: globalThis.fetch,
    publish: (input) => client.send(new PutMetricDataCommand(input)),
    log: (line) => console.log(JSON.stringify(line)),
  });
