// The files table of the server-side spine (lore 0027 notes/S-pr113-spine.md, AD-2), as data: every
// file a unit or the host probe writes under /var/log/x402, the log group and stream the agent
// sends it to, and how the agent splits and joins its lines. The agent config, the units, the
// rotation and the playbook are each checked against this one copy.

export const ENV = "production";
export const LOG_ROOT = "/var/log/x402";

/** Decision 24's two log groups, made by #114's Telemetry stack. */
export const GROUPS = { app: `/x402/${ENV}/app`, metrics: `/x402/${ENV}/metrics` } as const;

export interface FileRow {
  /** Under LOG_ROOT. */
  readonly path: string;
  readonly group: keyof typeof GROUPS;
  readonly stream: string;
  /** EMF lines only, or every line but EMF ones. */
  readonly filter?: "include-emf" | "exclude-emf";
  /** Whether the file can carry EMF lines, so every line starts an event (AD-3). */
  readonly emf: boolean;
  /** The symlink the metrics entry reads, so it keeps its own saved offset (decision 1). */
  readonly symlinkTo?: string;
}

export const FILES: readonly FileRow[] = [
  {
    path: `${ENV}/facilitator.log`,
    group: "app",
    stream: "facilitator",
    filter: "exclude-emf",
    emf: true,
  },
  {
    path: `${ENV}/emf/facilitator.log`,
    group: "metrics",
    stream: "facilitator",
    filter: "include-emf",
    emf: true,
    symlinkTo: "../facilitator.log",
  },
  { path: `${ENV}/facilitator.err.log`, group: "app", stream: "facilitator-stderr", emf: false },
  { path: `${ENV}/postgres-testnet.log`, group: "app", stream: "postgres-testnet", emf: false },
  { path: `${ENV}/cloudflared.log`, group: "app", stream: "cloudflared", emf: false },
  { path: `${ENV}/deploy.log`, group: "app", stream: "deploy", emf: false },
  // The portal's backend and its deploy (0106). The backend's lines carry jti, act, the outcome and
  // a short key_id, never the owner or a Discord id.
  { path: `${ENV}/portal.log`, group: "app", stream: "portal", emf: false },
  { path: `${ENV}/portal-deploy.log`, group: "app", stream: "portal-deploy", emf: false },
  { path: "openbao/openbao.log", group: "app", stream: "openbao", emf: false },
  { path: "metrics/agent.log", group: "app", stream: "metrics-agent", emf: false },
  { path: "host/metrics.log", group: "metrics", stream: "host", filter: "include-emf", emf: true },
];

export const absolute = (row: FileRow): string => `${LOG_ROOT}/${row.path}`;
