// Stand-in for ae-launch.mjs in tests (AE_MCP_TEST_LAUNCHER): the "After Effects" state comes from
// <bridge>/fake-ae.json, and every trigger is appended to <bridge>/triggers.txt as "run" or, when a
// dialog would have rejected it, "swallowed". MockPanel({ triggered: true }) runs one tick per "run".
import fs from "node:fs";
import path from "node:path";

export function createLauncher(config) {
  const stateFile = path.join(config.bridgeDir, "fake-ae.json");
  const read = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { running: true, modal: false }; }
  };
  return {
    async probe() { const s = read(); return { running: s.running !== false, modal: Boolean(s.modal), dialogs: s.dialogs ?? [], startTime: s.startTime ?? 1 }; },
    async trigger() {
      const s = read();
      let outcome = "run";
      if (s.modal || s.swallowNext) {
        outcome = "swallowed";
        if (s.swallowNext) fs.writeFileSync(stateFile, JSON.stringify({ ...s, swallowNext: false }));
      }
      fs.appendFileSync(path.join(config.bridgeDir, "triggers.txt"), outcome + "\n");
    }
  };
}
