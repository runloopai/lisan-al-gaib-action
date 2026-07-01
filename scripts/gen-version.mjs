import { readFileSync, writeFileSync } from "node:fs";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync("src/update/version.ts", `export const CLI_VERSION = ${JSON.stringify(version)};\n`);
