// Surface primitive: one background per region, no nested cards by default.
import type { ComponentChildren } from "preact";
import { panelClass } from "../../uiPrimitives";
import type { PanelLevel } from "../../uiPrimitives";

export interface PanelProps {
  level?: PanelLevel;
  class?: string;
  id?: string;
  role?: "region" | "navigation" | "group" | "complementary" | "main" | "status";
  ariaLabel?: string;
  children: ComponentChildren;
}

export function Panel(props: PanelProps) {
  return (
    <div class={panelClass(props.level, props.class)} id={props.id} role={props.role} aria-label={props.ariaLabel}>
      {props.children}
    </div>
  );
}

export default Panel;
