import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

// Keep this module independent of pi; the current coding-agent config directory is .pi.
const CONFIG_DIR_NAME = ".pi";

export interface AgentFile {
  name: string;
  path: string;
  scope: "project" | "workspace" | "global";
}

interface AgentDirectory {
  path: string;
  scope: AgentFile["scope"];
}

const directories = (cwd: string, agentDir: string): AgentDirectory[] => [
  { path: join(cwd, CONFIG_DIR_NAME, "agents"), scope: "project" },
  { path: join(cwd, ".agents", "agents"), scope: "workspace" },
  { path: join(agentDir, "agents"), scope: "global" },
];

function filesInDirectory(directory: AgentDirectory): AgentFile[] {
  try {
    return readdirSync(directory.path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => ({
        name: basename(entry.name, ".md"),
        path: join(directory.path, entry.name),
        scope: directory.scope,
      }));
  } catch {
    return [];
  }
}

export function allAgentFiles(cwd: string, agentDir: string): AgentFile[] {
  return directories(cwd, agentDir).flatMap(filesInDirectory);
}