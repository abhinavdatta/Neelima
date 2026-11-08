// Icon-only button. The accessible name is required by the type, because an
// icon glyph is not a label (3Q-1 finding A-4).
import { Icon } from "../Icon";
import type { IconName } from "../Icon";
import { iconButtonClass } from "../../uiPrimitives";

export interface IconButtonProps {
  icon: IconName;
  /** Accessible name; also used as the tooltip unless `title` overrides it. */
  label: string;
  title?: string;
  size?: number;
  disabled?: boolean;
  class?: string;
  onClick?: (event: MouseEvent) => void;
}

export function IconButton(props: IconButtonProps) {
  return (
    <button
      type="button"
      class={iconButtonClass(props.class)}
      aria-label={props.label}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={props.size ?? 16} />
    </button>
  );
}

export default IconButton;
