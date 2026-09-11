import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

const staticAssets = [
  "images",
  "lib",
  "styles",
  "options/options.html",
  "popup/popup.html",
];

export async function copyExtensionAssets(sourceDirectory, outputDirectory) {
  await Promise.all(staticAssets.map(async (asset) => {
    const destination = path.join(outputDirectory, asset);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(sourceDirectory, asset), destination, { recursive: true });
  }));
}
