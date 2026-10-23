// E2E probe: speak Native Messaging framing (4-byte LE length + JSON) to the
// real neelima_native_host.exe, which forwards to the running Neelima app.
const { spawn } = require("node:child_process");
const path = require("node:path");

const exe = path.join(__dirname, "target", "release", "neelima_native_host.exe");
const op = process.argv[2] || "bridge.status";
const uid = Math.random().toString(16).slice(2, 10);
const request = Buffer.from(
  JSON.stringify(
    op === "tool.propose"
      ? {
          version: 1,
          request_id: `e2e-probe-${uid}`,
          operation: "tool.propose",
          proposal: {
            version: 1,
            operation: "tool.propose",
            tool: process.argv[3] || "read_file",
            args: process.argv[3] === "list_dir" ? {} : { path: process.argv[3] || "e2e-probe.txt" },
            site: "chatgpt",
            page_origin: "https://chatgpt.com",
          },
        }
      : { version: 1, request_id: "e2e-probe-0001", operation: "bridge.status" },
  ),
  "utf8",
);
const framed = Buffer.alloc(4 + request.length);
framed.writeUInt32LE(request.length, 0);
request.copy(framed, 4);

const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
let out = Buffer.alloc(0);
const timer = setTimeout(() => { child.kill(); console.log("TIMEOUT no reply"); process.exit(2); }, 8000);
child.stdout.on("data", (d) => { out = Buffer.concat([out, d]); });
child.on("exit", () => {
  clearTimeout(timer);
  if (out.length < 4) { console.log("NO-REPLY bytes=" + out.length); process.exit(2); }
  const len = out.readUInt32LE(0);
  const body = out.subarray(4, 4 + len).toString("utf8");
  console.log("REPLY:", body);
});
child.stdin.write(framed);
child.stdin.end();
