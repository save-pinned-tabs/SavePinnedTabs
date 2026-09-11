import { cp } from "node:fs/promises";
import path from "node:path";
import { copyExtensionAssets } from "./extension-assets.mjs";

const projectRoot = process.cwd();
const sourceDirectory = path.join(projectRoot, "src");
const outputDirectory = path.join(projectRoot, ".extension-build");

await Promise.all([
  copyExtensionAssets(sourceDirectory, outputDirectory),
  cp(
    path.join(sourceDirectory, "manifest.json"),
    path.join(outputDirectory, "manifest.json"),
  ),
]);
