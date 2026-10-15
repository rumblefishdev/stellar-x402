import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const UPSTREAM_REPO = "https://github.com/x402-foundation/x402.git";

/** The pinned suite version (ADR 0009). Bumping it means a new gate run and new results. */
export const UPSTREAM_COMMIT = "10b2d06b9472bc467d139b272d01bface38ae2d8";

function run(command: string, args: string[], cwd: string) {
  console.log(`$ ${command} ${args.join(" ")}   (in ${cwd})`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function output(command: string, args: string[], cwd: string) {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A checkout of the suite at the pin, installed and built the way upstream's CI does it
 * (`.github/workflows/e2e_tests.yml`). Built once per directory; a marker file says it finished.
 *
 * Upstream's `e2e/setup.sh` would also build the Go and Python components, which the Stellar
 * scenarios never start, and fails without a Go toolchain. So only the TypeScript components'
 * own `install.sh` and `build.sh` run here, in the order `setup.sh` runs them.
 */
export function prepare(dir: string) {
  if (!existsSync(dir)) {
    run("git", ["clone", "--filter=blob:none", UPSTREAM_REPO, dir], ".");
    run("git", ["-c", "advice.detachedHead=false", "checkout", UPSTREAM_COMMIT], dir);
  }
  assertClean(dir);

  const marker = join(dir, ".gate-prepared");
  if (existsSync(marker)) return;
  run("pnpm", ["install", "--frozen-lockfile"], join(dir, "typescript"));
  run("pnpm", ["build"], join(dir, "typescript"));
  run("pnpm", ["install", "--frozen-lockfile"], join(dir, "e2e"));
  for (const component of typescriptComponents(join(dir, "e2e"))) {
    for (const script of ["install.sh", "build.sh"]) {
      if (existsSync(join(component, script))) run("bash", [script], component);
    }
  }
  writeFileSync(marker, `${UPSTREAM_COMMIT}\n`);
}

/** The checkout is the pinned commit with no tracked file changed: the suite is unmodified. */
export function assertClean(dir: string) {
  const head = output("git", ["rev-parse", "HEAD"], dir);
  if (head !== UPSTREAM_COMMIT) {
    throw new Error(`${dir} is at ${head}, not the pinned ${UPSTREAM_COMMIT}; delete it`);
  }
  const changed = output("git", ["status", "--porcelain", "--untracked-files=no"], dir);
  if (changed) throw new Error(`${dir} has changed upstream files; delete it:\n${changed}`);
}

/** `{servers,clients}/typescript/http/*` and `{servers,clients}/typescript/mcp`. */
function typescriptComponents(e2e: string) {
  const components: string[] = [];
  for (const role of ["servers", "clients"]) {
    const http = join(e2e, role, "typescript", "http");
    for (const entry of readdirSync(http, { withFileTypes: true })) {
      if (entry.isDirectory()) components.push(join(http, entry.name));
    }
    components.push(join(e2e, role, "typescript", "mcp"));
  }
  return components;
}
