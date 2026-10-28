import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { adminFetch } from "../process/daemon.js";
import type { RuntimeState } from "../bridge/runtime.js";
import type { TaskRequest } from "./task-queue.js";
import { TaskCoordinator, GoalTaskCoordinator, type LocalCoordinationGrant, type CoordinationStatus } from "./coordinator.js";

/** One local authorization at a time per workspace, independent of the daemon. */
export async function superviseLocalSession(runtime: RuntimeState, grant: LocalCoordinationGrant,
  signal: AbortSignal, notify: (status: CoordinationStatus) => void): Promise<CoordinationStatus> {
  const dir = ensureDir(path.join(getStateDir(), "coordination", runtime.workspaceId));
  const lock = path.join(dir, "active.lock");
  const nonce = randomUUID();
  let fd: number;
  try { fd = fs.openSync(lock, "wx", 0o600); }
  catch { throw new Error(`A coordinator lock already exists. Inspect the local session before removing a stale lock: ${lock}`); }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, rootTaskId: "rootTaskId" in grant ? grant.rootTaskId : null, expiresAt: grant.expiresAt }));
    const api = {
      list: async () => (await adminFetch<{ tasks: TaskRequest[] }>(runtime, "GET", "/admin/tasks", 5000)).tasks,
      approve: async (id: string) => { await adminFetch(runtime, "POST", `/admin/tasks/${id}/approve`, 5000); },
      run: async (id: string) => { await adminFetch(runtime, "POST", `/admin/tasks/${id}/run`, 5000); },
      release: async (id: string) => { await adminFetch(runtime, "POST", `/admin/tasks/${id}/release`, 5000); },
      cancel: async (id: string) => { await adminFetch(runtime, "POST", `/admin/tasks/${id}/cancel`, 5000); },
      approvals: async (id: string) => (await adminFetch<{ approvals: unknown[] }>(runtime, "GET", `/admin/tasks/${id}/approvals`, 5000)).approvals,
    };
    const notifyStatus = (status: CoordinationStatus): void => {
      const file = path.join(dir, `${status.sessionId}.json`);
      const temporary = file + ".tmp";
      fs.writeFileSync(temporary, JSON.stringify({ workspaceId: runtime.workspaceId,
        bridgeStartedAt: runtime.startedAt, grant, status }, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
      fs.appendFileSync(path.join(dir, `${status.sessionId}.events.jsonl`), JSON.stringify({ at: new Date().toISOString(), status }) + "\n", { mode: 0o600 });
      notify(status);
    };
    const coordinator = "goal" in grant ? new GoalTaskCoordinator(api, grant, notifyStatus) : new TaskCoordinator(api, grant, notifyStatus);
    return await coordinator.supervise(signal);
  } finally {
    fs.closeSync(fd);
    if (JSON.parse(fs.readFileSync(lock, "utf8")).nonce === nonce) fs.unlinkSync(lock);
  }
}
