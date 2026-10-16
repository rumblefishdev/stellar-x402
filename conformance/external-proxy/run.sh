#!/usr/bin/env bash
# Started by the x402 e2e suite in this folder with PORT set. exec, so the suite's SIGTERM reaches
# node rather than this shell.
exec node proxy.mjs
