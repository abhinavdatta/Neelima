import { render } from "preact";
import { App } from "./App";
import { initEasterEggs } from "./easterEggs";

render(<App />, document.getElementById("root")!);
initEasterEggs(); // 🥚 cosmetic only — see easterEggs.ts
