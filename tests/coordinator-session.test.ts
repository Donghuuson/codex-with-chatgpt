import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge } from "../src/bridge/server.js";
import { readRuntimeState } from "../src/bridge/runtime.js";
import { superviseLocalSession } from "../src/execution/coordinator-session.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("local coordination session", () => {
  it("locks one workspace, writes private audit records and preserves the live bridge", async () => {
    const stateDir = isolateStateDir(); const root = makeTmpDir("coordination");
    const queue = new TaskQueue(); const task = queue.submit("client", "Finished diagnostic");
    queue.transition(task.id, "pending", "approved"); queue.transition(task.id, "approved", "running"); queue.transition(task.id, "running", "completed", "OK");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue });
    const runtime = readRuntimeState(bridge.workspace.id)!;
    const grant = { rootTaskId: task.id, maxTasks: 2, expiresAt: Date.now() + 5000, allowFollowups: true };
    const controller = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => { ready = resolve; });
    const session = superviseLocalSession(runtime, grant, controller.signal, (status) => { if (status.state === "waiting_for_chatgpt") ready(); });
    try {
      await waiting;
      await expect(superviseLocalSession(runtime, grant, new AbortController().signal, () => {})).rejects.toThrow("lock already exists");
      controller.abort(); const final = await session;
      const dir = path.join(stateDir, "coordination", bridge.workspace.id);
      expect(fs.existsSync(path.join(dir, "active.lock"))).toBe(false);
      const file = path.join(dir, `${final.sessionId}.json`);
      const record = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(record.grant).toEqual(grant);
      expect(record.status.state).toBe("stopped");
      expect(record.bridgeStartedAt).toBe(runtime.startedAt);
      expect(fs.readFileSync(file, "utf8")).not.toContain(runtime.adminToken);
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(readRuntimeState(bridge.workspace.id)?.adminToken).toBe(runtime.adminToken);
      expect(queue.get("client", task.id).resultReleased).toBe(true);
    } finally { controller.abort(); await session; await bridge.close(); cleanup(root); cleanup(stateDir); }
  });

  it("removes its lock after invalid authorization without approving a task", async () => {
    const stateDir = isolateStateDir(); const root = makeTmpDir("invalid-coordination"); const queue = new TaskQueue();
    const task = queue.submit("client", "Do not run");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue });
    try {
      const runtime = readRuntimeState(bridge.workspace.id)!;
      await expect(superviseLocalSession(runtime, { rootTaskId: task.id, maxTasks: 99, expiresAt: Date.now() + 5000, allowFollowups: true }, new AbortController().signal, () => {})).rejects.toThrow();
      expect(fs.existsSync(path.join(stateDir, "coordination", bridge.workspace.id, "active.lock"))).toBe(false);
      expect(queue.get("client", task.id).state).toBe("pending");
    } finally { await bridge.close(); cleanup(root); cleanup(stateDir); }
  });
});
