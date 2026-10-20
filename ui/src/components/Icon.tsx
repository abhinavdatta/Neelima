import type { JSX } from "preact";

export type IconName =
  | "add" | "search" | "spark" | "grid" | "history" | "settings"
  | "close" | "folder" | "more" | "chevron" | "terminal"
  | "minimize" | "maximize" | "restore" | "arrow-up-right"
  | "code" | "layers" | "send" | "move" | "refresh" | "chevron-left"
  | "chevron-right" | "arrow-left" | "clock" | "check" | "alert" | "mail";

const paths: Record<IconName, JSX.Element> = {
  add: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
  spark: <><path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z" /><path d="m19 14 .9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14Z" /></>,
  grid: <><rect x="4" y="4" width="6" height="6" rx="1.4" /><rect x="14" y="4" width="6" height="6" rx="1.4" /><rect x="4" y="14" width="6" height="6" rx="1.4" /><rect x="14" y="14" width="6" height="6" rx="1.4" /></>,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /><path d="M3 7V3m0 4h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="m19.4 15 .1.2 1.4 2.4-2.2 2.2-2.6-1.4a7.8 7.8 0 0 1-1.8.8L13.8 22h-3.6l-.5-2.8a7.8 7.8 0 0 1-1.8-.8l-2.6 1.4-2.2-2.2 1.4-2.6a7.8 7.8 0 0 1-.7-1.8L1 12.7V9.3l2.8-.5a7.8 7.8 0 0 1 .8-1.8L3.2 4.4l2.2-2.2L8 3.6a7.8 7.8 0 0 1 1.8-.8L10.2 0h3.6l.5 2.8a7.8 7.8 0 0 1 1.8.8l2.6-1.4 2.2 2.2-1.4 2.6a7.8 7.8 0 0 1 .8 1.8l2.7.5v3.4l-2.8.5a7.8 7.8 0 0 1-.8 1.8Z" transform="translate(1 1) scale(.92)" /></>,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5L12 7.5h7.5A1.5 1.5 0 0 1 21 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" />,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  chevron: <path d="m7 10 5 5 5-5" />,
  terminal: <><rect x="2.5" y="3" width="19" height="18" rx="3" /><path d="m6 8 3.5 3L6 14m6 0h5" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1" />,
  restore: <><path d="M8 8V4h12v12h-4" /><rect x="4" y="8" width="12" height="12" rx="1" /></>,
  "arrow-up-right": <><path d="M7 17 17 7M8 7h9v9" /></>,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-2-12-4 14" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  send: <><path d="m3 10 18-7-7 18-3-8-8-3Z" /><path d="m11 13 5-5" /></>,
  move: <><path d="M12 3v18m-3-3 3 3 3-3M9 6l3-3 3 3M3 12h18m-3-3 3 3-3 3M6 9l-3 3 3 3" /></>,
  refresh: <><path d="M20 7v5h-5" /><path d="M19 12a7 7 0 1 1-2-5l3 5" /></>,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "arrow-left": <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  alert: <><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v4m0 3h.01" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
};

export function Icon({ name, size = 20, class: className, ...props }: { name: IconName; size?: number; class?: string } & JSX.SVGAttributes<SVGSVGElement>) {
  return <svg class={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" {...props}>{paths[name]}</svg>;
}
