import { existsSync, unlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const gitRepoCache = new Map<string, boolean>();

export function isGitRepo(cwd: string): boolean {
  const cached = gitRepoCache.get(cwd);
  if (cached !== undefined) return cached;
  let dir = cwd;
  while (true) {
    try {
      if (existsSync(join(dir, ".git"))) {
        gitRepoCache.set(cwd, true);
        return true;
      }
    } catch {
      gitRepoCache.set(cwd, false);
      return false;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      gitRepoCache.set(cwd, false);
      return false;
    }
    dir = parent;
  }
}

export function atomicWriteFileSync(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, "utf8");
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
}
