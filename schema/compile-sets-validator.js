const { writeFileSync } = require("node:fs");
const Ajv = require("ajv");
const standaloneCode = require("ajv/dist/standalone").default;
const schema = require("./sets.json");

const ajv = new Ajv({ code: { source: true } });
const validate = ajv.compile(schema);
const generated = standaloneCode(ajv, validate);
const browserBundle = `globalThis.validate20 = (() => {\n  const module = { exports: {} };\n  const exports = module.exports;\n  ${generated}\n  return module.exports;\n})();\n`;

writeFileSync("lib/validate_sets_schema.min.js", browserBundle);
