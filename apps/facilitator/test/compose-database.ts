/**
 * The repo's `compose.yaml` database (`docker compose up -d` at the repo root), in one place for the
 * tests and the live scripts. It imports nothing, so a script run with tsx can use it: the tests'
 * own `database.ts` imports vitest.
 */
export const COMPOSE_DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:15432/postgres";

/**
 * The variable `name` trimmed, or the compose database when it is unset or blank. The config reads a
 * blank value as unset too (`parseEnv`), so `DATABASE_URL=` left empty in a shell or an env file
 * falls back here instead of reaching the config as a missing setting, or `new URL("")`.
 */
export function urlOrCompose(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[name]?.trim() || COMPOSE_DATABASE_URL;
}

/** `DATABASE_URL`, read as `urlOrCompose` reads it: the live scripts' database. */
export function databaseUrlOrCompose(env: NodeJS.ProcessEnv = process.env): string {
  return urlOrCompose("DATABASE_URL", env);
}
