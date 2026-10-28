import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir, writeSecureJson } from "../config/paths.js";

const schema = z.object({ workspaceId: z.string().min(1), root: z.string(), command: z.string(), enabled: z.boolean() });
export type ExecutionSettings = z.infer<typeof schema>;
export function executionSettingsPath(workspaceId: string): string {
  if (!/^[a-f0-9]+$/i.test(workspaceId)) throw new Error("Invalid workspace ID");
  return path.join(getStateDir(), "execution", `${workspaceId}.settings.json`);
}
export function readExecutionSettings(workspaceId: string, root: string): ExecutionSettings | null {
  const file = executionSettingsPath(workspaceId);
  if (!fs.existsSync(file)) return null;
  const settings = schema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  if (settings.workspaceId !== workspaceId || fs.realpathSync(settings.root) !== fs.realpathSync(root)) throw new Error("Execution settings belong to another workspace");
  return settings;
}
export function writeExecutionSettings(settings: ExecutionSettings): void {
  schema.parse(settings);
  if (!path.isAbsolute(settings.command) || !fs.statSync(settings.command).isFile()) throw new Error("Codex executable must be an absolute file path");
  fs.accessSync(settings.command, fs.constants.X_OK);
  writeSecureJson(executionSettingsPath(settings.workspaceId), { ...settings, root: fs.realpathSync(settings.root), command: fs.realpathSync(settings.command) });
}
