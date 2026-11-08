// Status/risk chip primitive. Colour is semantic only: ok, warn, danger, muted.
import type { ComponentChildren } from "preact";
import { statusChipClass } from "../../uiPrimitives";
import type { ChipTone } from "../../uiPrimitives";

export interface StatusChipProps {
  tone?: ChipTone;
  title?: string;
  class?: string;
  children: ComponentChildren;
}

export function StatusChip(props: StatusChipProps) {
  return (
    <span class={statusChipClass(props.tone, props.class)} title={props.title}>
      {props.children}
    </span>
  );
}

export default StatusChip;
