# portal-web

The facilitator's page, served at `https://sorobanscan.com/api/x402-facilitator/`: what the
facilitator does and where a seller gets a pubnet API key (task 0106).

The landing page is the design, its text as designed. The search box only holds what is typed
(the facilitator has no `/discovery/search`), and the key card on it shows the design's
placeholders. The page has no sign-in and no dashboard of its own: every "Get API Key" is a link
to the API hub's sign-in, `HUB_SIGN_IN` in `src/hub.ts`, where a member signs in with Discord and
finds the key in the hub's dashboard. An address the page doesn't know shows the landing page.
The fonts (Space Grotesk, Manrope, JetBrains Mono, OFL-1.1) are in the bundle, so a visitor's
browser asks no other host for a file.

It is a static bundle (React, Vite). The block explorer's CloudFront distribution serves it from
the explorer's bucket, beside the Prices API's portal, so the routing lives in
`soroban-block-explorer` and this package only builds the files. The prefix is `BASE_PATH` in
`src/base-path.ts`; a test builds the page and checks that every file it asks for is under it,
and that no stylesheet names another host.

```sh
pnpm --filter @stellar-x402/portal-web dev      # http://localhost:5173/api/x402-facilitator/
pnpm --filter @stellar-x402/portal-web build    # dist/
pnpm --filter @stellar-x402/portal-web test
```
