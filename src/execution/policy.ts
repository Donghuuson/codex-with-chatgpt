import fs from "node:fs";
import path from "node:path";
import { SENSITIVE_PATTERNS } from "../workspace/ignore.js";

export const TASK_PROFILE = "c2c-task";

/** Per-process overrides; does not edit the user's Codex configuration. */
export function executionPolicyArgs(root: string, executable: string): string[] {
  const rules: Record<string, string> = { ".": "write" };
  for (const protectedPath of [".git", ".agents", ".codex", ".c2cignore"]) {
    if (fs.existsSync(path.join(root, protectedPath))) rules[protectedPath] = "read";
  }
  if (fs.existsSync(path.join(root, ".git/config"))) rules[".git/config"] = "deny";
  let custom = "";
  const ignoreFile = path.join(root, ".c2cignore");
  if (fs.existsSync(ignoreFile)) custom = fs.readFileSync(ignoreFile, "utf8");
  for (const line of [...SENSITIVE_PATTERNS, ...custom.split(/\r?\n/)]) {
    const pattern = line.trim();
    if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) continue;
    const relative = pattern.replace(/^\//, "").replace(/\/$/, "");
    if (relative.split("/").includes("..") || relative.includes("\\")) throw new Error("Unsupported execution ignore rule");
    rules[relative.includes("/") || pattern.startsWith("/") ? relative : `**/${relative}`] = "deny";
  }
  const base = `permissions.${TASK_PROFILE}`;
  const filesystem: Record<string, string | number | Record<string, string>> = {
    ":root": "deny",
    ":minimal": "read",
    ":tmpdir": "deny",
    ":slash_tmp": "deny",
    [path.dirname(fs.realpathSync(executable))]: "read",
    [fs.realpathSync(process.execPath)]: "read",
    glob_scan_max_depth: 32,
    ":workspace_roots": rules,
  };
  const inline = (value: unknown): string => {
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return `{${Object.entries(value as object).map(([key, entry]) => `${JSON.stringify(key)}=${inline(entry)}`).join(",")}}`;
  };
  return ["-c", `${base}.filesystem=${inline(filesystem)}`, "-c", `${base}.network.enabled=false`,
    "-c", 'shell_environment_policy.inherit="core"', "-c", 'shell_environment_policy.ignore_default_excludes=false',
    "-c", "mcp_servers={}", "-c", "features.apps=false"];
}
