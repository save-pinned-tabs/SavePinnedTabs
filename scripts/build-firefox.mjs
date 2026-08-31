import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const runtimePaths = [
  "functions.js",
  "images",
  "lib",
  "LICENSE",
  "options.html",
  "options.js",
  "popup.html",
  "popup.js",
  "service_worker.js",
  "style.css",
];

const projectRoot = process.cwd();
const stagingDirectory = await mkdtemp(
  path.join(os.tmpdir(), "save-pinned-tabs-firefox-"),
);
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.background = {
  scripts: ["service_worker.js"],
  type: "module",
};

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
      cp(source, path.join(stagingDirectory, source), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(stagingDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await mkdir("dist", { recursive: true });
  await runWebExt(["lint", "--source-dir", stagingDirectory]);
  await runWebExt([
    "build",
    "--source-dir",
    stagingDirectory,
    "--artifacts-dir",
    "dist",
    "--filename",
    `save_pinned_tabs-${manifest.version}-firefox.zip`,
    "--overwrite-dest",
  ]);
} finally {
  await rm(stagingDirectory, { recursive: true, force: true });
}
