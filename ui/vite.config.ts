import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Tauri expects a fixed port; CodeMirror/xterm are lazy-loaded chunks so the
// entry bundle stays tiny.
export default defineConfig({
  plugins: [preact()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "chrome110", chunkSizeWarningLimit: 900 },
});
