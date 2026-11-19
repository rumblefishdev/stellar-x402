import type { ReactNode } from "react";
import { HUB_SIGN_IN } from "../hub";

/** A section's badge, its heading and, when it has one, the paragraph under it. */
export function SectionHead(props: {
  badge: string;
  id: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-head">
      <p className="badge">{props.badge}</p>
      <h2 id={props.id}>{props.title}</h2>
      {props.children && <p className="lead">{props.children}</p>}
    </div>
  );
}

/**
 * The arrow in a disc that ends the page's two calls to action, as the Prices API portal's end
 * (its `ArrowBadge`): black on the yellow button, outlined on the dark one (`styles.css`).
 * Decoration, so a screen reader reads the button's words alone.
 */
function ArrowBadge() {
  return (
    <span aria-hidden="true" className="arrow-badge">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" focusable="false">
        <path d="M5 13h11.17l-4.88 4.88c-.39.39-.39 1.03 0 1.42s1.02.39 1.41 0l6.59-6.59c.39-.39.39-1.02 0-1.41l-6.58-6.6a.996.996 0 0 0-1.41 0c-.39.39-.39 1.02 0 1.41L16.17 11H5c-.55 0-1 .45-1 1s.45 1 1 1" />
      </svg>
    </span>
  );
}

/** Every "Get API Key" on the page: to the hub's sign-in. */
export function GetKeyLink() {
  return (
    <a className="btn btn-primary btn-arrow" href={HUB_SIGN_IN}>
      Get API Key
      <ArrowBadge />
    </a>
  );
}

/**
 * The top bar's button: the same sign-in, named for what it opens (akot, 2026-11-19). The key is
 * one press further on, in the hub's dashboard.
 */
export function LogInLink() {
  return (
    <a className="btn btn-primary" href={HUB_SIGN_IN}>
      Log in
    </a>
  );
}

export function DocsLink() {
  return (
    <a className="btn btn-dark btn-arrow" href="#quickstart">
      View documentation
      <ArrowBadge />
    </a>
  );
}
