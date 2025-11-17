// scripts/autoGit.js
import { execSync } from "node:child_process";

export function autoCommit(label) {
  // 1) Check if git is available & repo is initialized
  let status = "";
  try {
    status = execSync("git status --porcelain", {
      encoding: "utf8",
    }).trim();
  } catch (err) {
    console.log(
      "[git] Skipping auto-commit (git not initialized or git not available)."
    );
    return;
  }

  if (!status) {
    console.log("[git] No changes to commit.");
    return;
  }

  const safeLabel = String(label ?? "").replace(/"/g, '\\"');
  const msg = `chore: auto-commit after ${safeLabel}`;

  try {
    console.log("[git] Staging changes...");
    execSync("git add .", { stdio: "inherit" });

    console.log(`[git] Committing with message: "${msg}"`);
    execSync(`git commit -m "${msg}"`, { stdio: "inherit" });
  } catch (err) {
    console.error("[git] Auto-commit failed:", err?.message ?? err);
  }
}
