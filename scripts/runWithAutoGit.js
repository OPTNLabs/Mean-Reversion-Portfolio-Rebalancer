// scripts/runWithAutoGit.js
import { spawn } from "node:child_process";
import { autoCommit } from "./autoGit.js";

const cmd = process.argv[2] ?? "fund";

console.log(`[runner] Running: node index.js ${cmd}`);

const child = spawn("node", ["index.js", cmd], {
  stdio: "inherit",
});

child.on("close", (code) => {
  if (code === 0) {
    console.log(
      `[runner] Command "node index.js ${cmd}" completed successfully.`
    );
    autoCommit(cmd);
  } else {
    console.error(
      `[runner] Command "node index.js ${cmd}" failed with exit code ${code}. Skipping auto-commit.`
    );
    process.exit(code);
  }
});
