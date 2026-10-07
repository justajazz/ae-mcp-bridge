#!/usr/bin/env node
// Runs tests/*.test.mjs with node --test. Lists the files itself because shells (cmd on Windows) and
// Node before 21 do not expand the glob.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tests");
const files = fs.readdirSync(dir).filter(name => name.endsWith(".test.mjs")).map(name => path.join(dir, name));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
