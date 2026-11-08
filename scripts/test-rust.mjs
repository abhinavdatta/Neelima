#!/usr/bin/env node
// Run the Rust test suite with a Windows workaround.
//
// WHY: the Neelima lib unit-test binary links wry/tauri, whose Windows dialog
// chain imports `TaskDialogIndirect` from comctl32 v6. An exe that imports it
// without a manifest selecting comctl32 v6 aborts at load time with
// 0xc0000139 (STATUS_ENTRYPOINT_NOT_FOUND) before `main` — so cargo reports a
// "test failed" that has nothing to do with the tests.
//
// INTEGRATION tests get src-tauri/tests/app.manifest embedded by build.rs
// (`rustc-link-arg-tests`). Cargo does NOT apply that channel to the lib's own
// unit-test target, and passing it through plain `rustc-link-arg` would also
// hit the app binary, which already embeds tauri-build's manifest (CVT1100
// duplicate MANIFEST). The Windows loader DOES honour an EXTERNAL manifest
// (`<exe>.manifest`) for an exe that has none embedded, which is exactly the
// lib-test binary's situation. So: build first, drop a sibling manifest next
// to each test exe, then run the suite. Binaries that embed their own manifest
// ignore the sibling file.
//
// Usage: node scripts/test-rust.mjs [cargo test args...]   (default: --workspace)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestSource = join(root, "src-tauri", "tests", "app.manifest");
const args = process.argv.slice(2).length ? process.argv.slice(2) : ["--workspace"];
const cargo = process.env.CARGO || "cargo";

function run(argv, { captureStderr = false } = {}) {
  const result = spawnSync(cargo, argv, {
    cwd: root,
    stdio: captureStderr ? ["inherit", "inherit", "pipe"] : "inherit",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`failed to run cargo: ${result.error.message}`);
    process.exit(1);
  }
  if (captureStderr) {
    const stderr = String(result.stderr || "");
    if (stderr) process.stderr.write(stderr);
    // A running Neelima holds target/debug/neelima.exe; cargo cannot relink it
    // and reports "failed to remove file … Access is denied". Say what to do
    // instead of leaving a bare os error.
    if (/failed to remove file.*\.exe/i.test(stderr) && /Access is denied/i.test(stderr)) {
      console.error(
        "\nThe Neelima app is running and holds its own executable. Close it (or set\n" +
          "CARGO_TARGET_DIR to a separate directory) and re-run this command."
      );
    }
  }
  return result.status ?? 1;
}

// 1. Compile everything first: no test exe can be patched before it exists.
const buildStatus = run(["test", ...args, "--no-run"], { captureStderr: true });
if (buildStatus !== 0) {
  console.error("\ncargo test --no-run failed; not running tests.");
  process.exit(buildStatus);
}

// 2. Patch test binaries (Windows only).
let patched = 0;
if (process.platform === "win32") {
  if (!existsSync(manifestSource)) {
    console.error(`missing ${manifestSource}; test binaries may fail to load.`);
    process.exit(1);
  }
  const manifest = readFileSync(manifestSource);
  const targetDir = resolve(root, process.env.CARGO_TARGET_DIR || "target");
  for (const profile of ["debug", "release"]) {
    const deps = join(targetDir, profile, "deps");
    if (!existsSync(deps) || !statSync(deps).isDirectory()) continue;
    for (const entry of readdirSync(deps)) {
      if (!entry.endsWith(".exe")) continue;
      const exe = join(deps, entry);
      const sibling = `${exe}.manifest`;
      const current = existsSync(sibling) ? readFileSync(sibling) : null;
      if (current && current.equals(manifest)) continue;
      writeFileSync(sibling, manifest);
      patched += 1;
    }
  }
  console.log(`\ncomctl32 v6 manifest written next to ${patched} test/binary exe(s).`);
}

// 3. Run the suite. Cargo finds the just-built binaries Fresh, so nothing is
// relinked between the patch and the run.
process.exit(run(["test", ...args]));
