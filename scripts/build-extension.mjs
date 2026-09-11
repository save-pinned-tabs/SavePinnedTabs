import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { copyExtensionAssets } from "./extension-assets.mjs";


const target = process.argv[2];
if (target !== "chromium" && target !== "firefox") {
  throw new Error("Usage: node scripts/build-extension.mjs <chromium|firefox>");
}

const projectRoot = process.cwd();
const sourceDirectory = path.join(projectRoot, "src");
const stagingDirectory = await mkdtemp(
  path.join(os.tmpdir(), `save-pinned-tabs-${target}-`),
);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with status ${code}`));
    });
  });
}

try {
  const manifest = JSON.parse(
    await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"),
  );

  if (target === "firefox") {
    manifest.background = {
      scripts: ["background/service-worker.js"],
      type: "module",
    };
    manifest.permissions = manifest.permissions.filter(
      (permission) => permission !== "favicon",
    );
  }

  await run(path.join(projectRoot, "node_modules/typescript/bin/tsc"), [
    "--outDir",
    stagingDirectory,
  ]);

  await copyExtensionAssets(sourceDirectory, stagingDirectory);

  await cp(
    path.join(projectRoot, "LICENSE"),
    path.join(stagingDirectory, "LICENSE"),
  );
  await writeFile(
    path.join(stagingDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  await mkdir(path.join(projectRoot, "dist"), { recursive: true });

  const webExt = path.join(projectRoot, "node_modules/web-ext/bin/web-ext.js");
  if (target === "firefox") {
    await run(webExt, ["lint", "--source-dir", stagingDirectory]);
  }
  await run(webExt, [
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