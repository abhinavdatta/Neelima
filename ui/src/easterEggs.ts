// 🥚 Easter eggs — tiny, self-contained, purely cosmetic.
//
// Hard rules for everything in this file:
//   * never preventDefault / stopPropagation (never intercepts real input),
//   * never touches app state, settings, or the store beyond a toast,
//   * never runs any privileged path — it is display-only fun.
// If an egg ever needs more than a toast and a CSS class, it is not an egg.
import { toast } from "./store";

const KONAMI = [
  "ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a",
];

const SECRETS = [
  "🥚 You found one. Konami works too: ↑↑↓↓←→←→BA",
  "🥚 Achievement unlocked: clicked the heading that wasn't a button.",
  "🥚 Neelima runs entirely on your machine. Even this toast.",
  "🥚 Insider tip: Ctrl+N always starts a fresh conversation.",
  "🥚 The best code is the code you didn't have to write.",
];

let konamiPos = 0;
let partyTimer: number | undefined;
let clicks: number[] = [];
let lastSecretAt = 0;

/** Called once from main.tsx after render. Safe to call twice. */
export function initEasterEggs() {
  try {
    console.log(
      "%c🥚 Neelima %c local-first agent — your keys, your machine, your rules.\n%c psst: ↑↑↓↓←→←→BA",
      "color:#8b7cf6;font-size:14px;font-weight:bold",
      "color:#9aa0b0",
      "color:#5f6678;font-style:italic",
    );
  } catch {
    /* console may be unavailable; an egg is never worth an error */
  }
  window.addEventListener("keydown", onKonamiKey);
}

/** Konami code → a few seconds of confetti-ish border glow. Observational only. */
function onKonamiKey(ev: KeyboardEvent) {
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  konamiPos = key === KONAMI[konamiPos] ? konamiPos + 1 : key === KONAMI[0] ? 1 : 0;
  if (konamiPos !== KONAMI.length) return;
  konamiPos = 0;
  const root = document.documentElement;
  root.classList.add("party-mode");
  window.clearTimeout(partyTimer);
  partyTimer = window.setTimeout(() => root.classList.remove("party-mode"), 8000);
  toast("info", "🎉 Party mode. Zero production impact, promised.");
}

/** 7 clicks on the welcome heading within ~2 s → a random secret. */
export function noteSecretClick() {
  const now = Date.now();
  clicks = clicks.filter((t) => now - t < 2000).concat(now);
  if (clicks.length < 7) return;
  clicks = [];
  if (now - lastSecretAt < 15_000) return; // no spamming the easter egg
  lastSecretAt = now;
  toast("info", SECRETS[Math.floor(Math.random() * SECRETS.length)]);
}
