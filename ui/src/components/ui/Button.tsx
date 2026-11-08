// Shared button primitive (Phase 3Q-2a). Maps the five semantic variants onto
// the class names the app already ships, so adopting it changes no markup and
// no geometry — it exists to make the primary/destructive hierarchy explicit at
// the call site instead of relying on whoever remembers which class is filled.
import type { ComponentChildren } from "preact";
import { buttonClass } from "../../uiPrimitives";
import type { ButtonVariant } from "../../uiPrimitives";

export interface ButtonProps {
  variant?: ButtonVariant;
  /** Defaults to "button": these controls never submit a form. */
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  ariaPressed?: boolean;
  class?: string;
  onClick?: (event: MouseEvent) => void;
  children: ComponentChildren;
}

export function Button(props: ButtonProps) {
  return (
    <button
      type={props.type ?? "button"}
      class={buttonClass(props.variant, props.class)}
      disabled={props.disabled}
      title={props.title}
      aria-label={props.ariaLabel}
      aria-pressed={props.ariaPressed}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export default Button;
