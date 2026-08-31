import { copyFile } from "node:fs/promises";

await Promise.all([
  copyFile(
    "node_modules/sweetalert2/dist/sweetalert2.esm.min.js",
    "lib/sweetalert2.esm.min.js",
  ),
  copyFile(
    "node_modules/sweetalert2/dist/sweetalert2.min.css",
    "lib/sweetalert2.min.css",
  ),
]);
