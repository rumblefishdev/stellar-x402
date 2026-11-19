import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "../src/App";
import { HUB_SIGN_IN } from "../src/hub";

afterEach(() => {
  cleanup();
  window.history.pushState(null, "", "/");
});

const at = (path = "/") => {
  window.history.pushState(null, "", path);
  return render(<App />);
};
const headings = () => screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent);

it("has one top heading on the landing page, its promise", () => {
  at("/");
  expect(headings()).toEqual(["Get your API found by AI agents"]);
});

it("points every in-page link at a part of the page", () => {
  const { container } = at("/");
  const targets = [...container.querySelectorAll('a[href^="#"]')].map((a) =>
    a.getAttribute("href")!.slice(1),
  );
  expect(targets.length).toBeGreaterThan(0);
  for (const id of new Set(targets)) expect(container.querySelector(`[id="${id}"]`)).not.toBeNull();
});

it("names every section with a heading that exists", () => {
  const { container } = at("/");
  for (const section of container.querySelectorAll("section[aria-labelledby]")) {
    const id = section.getAttribute("aria-labelledby")!;
    expect(section.querySelector(`[id="${id}"]`)).not.toBeNull();
  }
});

it("puts an example in the search box when it is picked", () => {
  at("/");
  fireEvent.click(screen.getByRole("button", { name: "Weather forecast" }));
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("Weather forecast");
});

it("sends every Get API Key to the hub's sign-in, in the same tab", () => {
  expect(HUB_SIGN_IN).toBe("https://sorobanscan.com/api/login?from=x402");
  at();
  const links = screen.getAllByRole("link", { name: "Get API Key" });
  expect(links.length).toBeGreaterThan(1);
  for (const link of links) {
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("https://sorobanscan.com/api/login?from=x402");
    expect(link.getAttribute("target")).toBeNull();
  }
  expect(screen.queryByRole("button", { name: "Get API Key" })).toBeNull();
});

// The top bar's button says what it does (akot, 2026-11-19): it opens the hub's sign-in, where the
// key is one press further on. The page's own "Get API Key" buttons keep their words.
it("offers Log in in the top bar, to the hub's sign-in", () => {
  at();
  const bar = within(screen.getByRole("navigation", { name: "Main" }));
  const logIn = bar.getByRole("link", { name: "Log in" });
  expect(logIn.getAttribute("href")).toBe(HUB_SIGN_IN);
  expect(logIn.getAttribute("target")).toBeNull();
  expect(logIn.className).toBe("btn btn-primary");
  expect(bar.queryByRole("link", { name: "Get API Key" })).toBeNull();
});

// As the Prices API portal draws its own two (akot, 2026-11-19): the arrow in a disc after the
// words, which a screen reader doesn't read.
it("draws Get API Key and View documentation with the arrow of the Prices API portal's", () => {
  at();
  const calls = [
    ...screen.getAllByRole("link", { name: "Get API Key" }),
    ...screen.getAllByRole("link", { name: "View documentation" }),
  ];
  expect(screen.getAllByRole("link", { name: "View documentation" }).length).toBeGreaterThan(0);
  for (const call of calls) {
    const badge = call.querySelector(".arrow-badge");
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
    expect(badge?.querySelector("svg")).not.toBeNull();
    expect(call.classList.contains("btn-arrow")).toBe(true);
  }
});

it("names no route of this page in the key card", () => {
  const { container } = at();
  const card = container.querySelector(".key-card");
  expect(card).not.toBeNull();
  expect(card!.querySelector("a")).toBeNull();
  expect(card!.innerHTML).not.toMatch(/\/login|\/dashboard/);
});

it.each(["/api/x402-facilitator/login", "/api/x402-facilitator/dashboard", "/no-such-page"])(
  "shows the landing page at %s",
  (path) => {
    at(path);
    expect(headings()).toEqual(["Get your API found by AI agents"]);
  },
);
