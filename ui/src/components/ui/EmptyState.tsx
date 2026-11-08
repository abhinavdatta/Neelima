// Shared empty/placeholder state. The search pane's empty state is the model:
// one line that says what happened, one that says what to do next.
import type { ComponentChildren } from "preact";
import { Icon } from "../Icon";
import type { IconName } from "../Icon";

export interface EmptyStateProps {
  title: string;
  children?: ComponentChildren;
  icon?: IconName;
  action?: ComponentChildren;
  class?: string;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class={props.class ? `empty-state ${props.class}` : "empty-state"} role="status">
      {props.icon ? <Icon name={props.icon} size={20} /> : null}
      <strong>{props.title}</strong>
      {props.children ? <p>{props.children}</p> : null}
      {props.action}
    </div>
  );
}

export default EmptyState;
