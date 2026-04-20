// ui.ts — SnapMe UI helpers for Farcaster Snap JSON

export type TextOptions = {
  weight?: "bold" | "normal";
  size?: "sm" | "md" | "lg";
  align?: "left" | "center" | "right";
};

export type ButtonVariant = "primary" | "ghost" | "default";

export type ButtonOptions = {
  variant?: ButtonVariant;
};

// ─── text ──────────────────────────────────────────────────────────────────
export function text(content: string, opts: TextOptions = {}): object {
  return {
    type: "text",
    props: {
      content,
      weight: opts.weight ?? "normal",
      size: opts.size ?? "md",
      align: opts.align ?? "left",
    },
  };
}

// ─── button ────────────────────────────────────────────────────────────────
export function button(
  label: string,
  action: string,
  target: string,
  opts: ButtonOptions = {}
): object {
  return {
    type: "button",
    props: {
      label,
      action,
      target,
      variant: opts.variant ?? "default",
    },
  };
}

// ─── stack ─────────────────────────────────────────────────────────────────
export function stack(
  children: string[],
  direction: "vertical" | "horizontal" = "vertical"
): object {
  return {
    type: "stack",
    props: {
      direction,
      children,
    },
  };
}

// ─── progress ──────────────────────────────────────────────────────────────
export function progress(value: number, max: number, label: string): object {
  return {
    type: "progress",
    props: {
      value,
      max,
      label,
    },
  };
}

// ─── input ─────────────────────────────────────────────────────────────────
export function input(
  name: string,
  label: string,
  placeholder: string,
  maxLength: number = 280
): object {
  return {
    type: "input",
    props: {
      name,
      label,
      placeholder,
      maxLength,
    },
  };
}

// ─── buildSnap ─────────────────────────────────────────────────────────────
export function buildSnap(
  elements: Record<string, object>,
  root: string,
  theme: "purple" | "green" | "red" | "blue" = "purple"
): object {
  return {
    type: "snap",
    theme,
    root,
    elements,
  };
}
