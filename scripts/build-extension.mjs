import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const runtimePaths = [
  "autoload.mjs",
  "functions.js",
  "images",
  "lib",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "service_worker.js",
  "shortcuts.mjs",
  "style.css",
];

const target = process.argv[2];
if (target !== "chromium" && target !== "firefox") {
  throw new Error("Usage: node scripts/build-extension.mjs <chromium|firefox>");
}

const projectRoot = process.cwd();
const sourceDirectory = path.join(projectRoot, "src");
const stagingDirectory = await mkdtemp(
  path.join(os.tmpdir(), `save-pinned-tabs-${target}-`),
);
const manifest = JSON.parse(
  await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"),
);

if (target === "firefox") {
  manifest.background = {
    scripts: ["service_worker.js"],
    type: "module",
  };
  manifest.permissions = manifest.permissions.filter(
    (permission) => permission !== "favicon",
  );
}

async function runWebExt(args) {
  await new Promise((resolve, reject) => {
    const command = path.join(
      projectRoot,
      "node_modules/web-ext/bin/web-ext.js",
    );
    const child = spawn(process.execPath, [command, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`web-ext exited with status ${code}`));
    });
  });
}

try {
  await Promise.all(
    runtimePaths.map((source) =>
      cp(
        path.join(sourceDirectory, source),
        path.join(stagingDirectory, source),
        { recursive: true },
      ),
    ),
  );
  await cp(
    path.join(projectRoot, "LICENSE"),
    path.join(stagingDirectory, "LICENSE"),
  );
  await writeFile(
    path.join(stagingDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await mkdir("dist", { recursive: true });
  if (target === "firefox") {
    await runWebExt(["lint", "--source-dir", stagingDirectory]);
  }
  await runWebExt([
    "build",
    "--source-dir",
    stagingDirectory,
    "--artifacts-dir",
    "dist",
    "--filename",
    `save_pinned_tabs-${manifest.version}${target === "firefox" ? "-firefox" : ""}.zip`,
    "--overwrite-dest",
  ]);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
