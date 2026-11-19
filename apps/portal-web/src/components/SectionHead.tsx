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

/** Every "Get API Key" on the page: to the hub's sign-in. */
export function GetKeyLink() {
  return (
    <a className="btn btn-primary" href={HUB_SIGN_IN}>
      Get API Key
    </a>
  );
}

export function DocsLink() {
  return (
    <a className="btn btn-ghost" href="#quickstart">
      View documentation
    </a>
  );
}
