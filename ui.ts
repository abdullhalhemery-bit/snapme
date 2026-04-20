// ui.ts — Snap UI builders following Farcaster Snap 2.0 spec

export type SnapTheme = "purple" | "green" | "red" | "blue" | "orange";

export type Elements = Record<string, unknown>;

// ─── Primitive builders ────────────────────────────────────────────────────

export function txt(content: string, opts: { weight?: "bold"; size?: "sm" | "lg"; align?: "center" } = {}) {
  return { type: "text", props: { content, ...opts } };
}

export function btn(label: string, target: string, variant?: "primary" | "secondary") {
  return {
    type: "button",
    props: { label, variant: variant || "secondary" },
    on: { press: { action: "submit", params: { target } } },
  };
}

export function vstack(...children: string[]) {
  return { type: "stack", props: { direction: "vertical" }, children };
}

export function hstack(...children: string[]) {
  return { type: "stack", props: { direction: "horizontal" }, children };
}

export function bar(value: number, max: number, label: string) {
  return { type: "progress", props: { value, max, label } };
}

export function inp(name: string, label: string, placeholder: string, maxLength = 280) {
  return { type: "input", props: { name, label, placeholder, maxLength } };
}

// ─── buildSnap ─────────────────────────────────────────────────────────────

export function buildSnap(root: string, elements: Elements, accent: SnapTheme = "purple") {
  return {
    version: "2.0",
    theme: { accent },
    ui: { root, elements },
  };
}
