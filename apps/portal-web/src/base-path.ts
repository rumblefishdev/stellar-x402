/**
 * The prefix the page is served from, `https://sorobanscan.com/api/x402-facilitator/` (0106
 * decision 1), in the explorer's CloudFront distribution beside prices-api's portal. Vite's `base`
 * takes it from here, so the built page asks for its files under the prefix. It ends with a
 * slash: without one Vite joins it to the file names.
 */
export const BASE_PATH = "/api/x402-facilitator/";
