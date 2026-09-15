// Cross-platform post-build step for `npm run build`.
// Replaces the Unix-only `rm/cp/cat/chmod` shell chain (which fails on
// Windows cmd/PowerShell) so the build works everywhere Node runs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 1. Python backend is a runtime-only script: copy it verbatim into dist.
const srcPy = path.join(root, "src", "backends", "python");
const dstPy = path.join(root, "dist", "backends", "python");
fs.rmSync(dstPy, { recursive: true, force: true });
fs.cpSync(srcPy, dstPy, { recursive: true });

// 1.5. Frontend static assets: copy src/web -> dist/web so `qmd serve` hosts them.
const srcWeb = path.join(root, "src", "web");
const dstWeb = path.join(root, "dist", "web");
if (fs.existsSync(srcWeb)) {
  fs.rmSync(dstWeb, { recursive: true, force: true });
  fs.cpSync(srcWeb, dstWeb, { recursive: true });
}

// 2. Ensure the CLI entry has a shebang so it can run directly as `qmd`.
const qmdJs = path.join(root, "dist", "cli", "qmd.js");
let content = fs.readFileSync(qmdJs, "utf-8");
if (!content.startsWith("#!")) {
  content = "#!/usr/bin/env node\n" + content;
  fs.writeFileSync(qmdJs, content);
}

// 3. Make it executable (no-op on Windows, meaningful on Unix).
try {
  fs.chmodSync(qmdJs, 0o755);
} catch {
  // chmod is irrelevant on Windows; ignore.
}

console.log("build-dist: dist ready (python backend copied, shebang + chmod applied)");
