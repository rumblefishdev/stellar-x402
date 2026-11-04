// The uptime probe's handler. The AWS SDK v3 comes with the Lambda Node.js runtime, so nothing is
// bundled (as the explorer's galexie-protocol-watch); the logic and its tests are in probe.mjs.
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { runProbe } from "./probe.mjs";

const client = new CloudWatchClient({});

export const handler = async () => {
  const url = process.env.HEALTH_URL;
  if (!url) throw new Error("HEALTH_URL is not set");
  return runProbe({
    url,
    fetch: globalThis.fetch,
    publish: (input) => client.send(new PutMetricDataCommand(input)),
    log: (line) => console.log(JSON.stringify(line)),
  });
};
