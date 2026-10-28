import { describe, expect, it } from "vitest";
import path from "node:path";
import { readExecutionSettings, writeExecutionSettings } from "../src/execution/settings.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("workspace execution settings", () => {
  it("is disabled without explicit settings and binds settings to one workspace", () => {
    const state = isolateStateDir();
    const root = makeTmpDir("execution-settings");
    const other = makeTmpDir("execution-other");
    try {
      const workspace = new Workspace(root);
      expect(readExecutionSettings(workspace.id, root)).toBeNull();
      writeExecutionSettings({ workspaceId: workspace.id, root, command: process.execPath, enabled: false });
      expect(readExecutionSettings(workspace.id, root)?.enabled).toBe(false);
      expect(() => readExecutionSettings(workspace.id, other)).toThrow("another workspace");
      expect(() => writeExecutionSettings({ workspaceId: workspace.id, root, command: path.join(root, "missing"), enabled: true })).toThrow();
    } finally { cleanup(root); cleanup(other); cleanup(state); }
  });
});
