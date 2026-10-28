import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskRequest } from "./task-queue.js";

export interface CoordinatorApi {
  list(): Promise<TaskRequest[]>;
  approve(id: string): Promise<void>;
  run(id: string): Promise<void>;
  release(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  approvals(id: string): Promise<unknown[]>;
}

export interface CoordinationGrant {
  rootTaskId: string;
  maxTasks: number;
  expiresAt: number;
  allowFollowups: boolean;
  /** Optional exact allowlist for a narrowly scoped diagnostic session. */
  allowedMessages?: string[];
}

export interface GoalCoordinationGrant extends Omit<CoordinationGrant, "rootTaskId"> {
  /** Exact locally authorized text; fuzzy/semantic matching never grants execution. */
  goal: string;
  owner: string;
}
export type LocalCoordinationGrant = CoordinationGrant | GoalCoordinationGrant;

export interface CoordinationStatus {
  sessionId: string;
  rootTaskId: string | null;
  owner: string;
  goal: string;
  expiresAt: number;
  maxTasks: number;
  handled: string[];
  activeTaskId: string | null;
  state: "authorizing" | "waiting_for_task" | "running" | "waiting_for_chatgpt" | "waiting_for_user" | "limit_reached" | "expired" | "stopped" | "blocked";
  reason: string | null;
}

const bounds = {
  maxTasks: z.number().int().min(1).max(12),
  expiresAt: z.number().finite(), allowFollowups: z.boolean(), allowedMessages: z.array(z.string().min(1).max(10_000)).min(1).optional(),
};
const grantSchema = z.object({ ...bounds, rootTaskId: z.string().uuid() });
const goalGrantSchema = z.object({ ...bounds, goal: z.string().min(1).max(10_000).refine((text) => text.trim().length > 0), owner: z.string().min(1).max(500) });
function validateExpiry(expiresAt: number): void {
  if (expiresAt <= Date.now() || expiresAt > Date.now() + 60 * 60_000) throw new Error("Session expiry must be within one hour");
}
async function pause(signal: AbortSignal, deadline: number, pollMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, Math.min(pollMs, Math.max(1, deadline - Date.now())));
    signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
}

/** Local-only supervisor. It never grants Codex command/file escalations. */
export class TaskCoordinator {
  constructor(private readonly api: CoordinatorApi, private readonly grant: CoordinationGrant,
    private readonly onStatus: (status: CoordinationStatus) => void = () => {},
    private readonly pollMs = 1000, private readonly sessionId = randomUUID(),
    private readonly expectedRoot?: { owner: string; message: string }) {
    grantSchema.parse(grant);
    validateExpiry(grant.expiresAt);
  }

  async supervise(signal: AbortSignal): Promise<CoordinationStatus> {
    const initial = (await this.api.list()).find((task) => task.id === this.grant.rootTaskId);
    if (!initial) throw new Error("Root task not found");
    if (this.expectedRoot && (initial.owner !== this.expectedRoot.owner || initial.message !== this.expectedRoot.message)) throw new Error("Root identity changed before binding");
    const status: CoordinationStatus = {
      sessionId: this.sessionId, rootTaskId: initial.id, owner: initial.owner, goal: initial.message,
      expiresAt: this.grant.expiresAt, maxTasks: this.grant.maxTasks, handled: [], activeTaskId: null,
      state: "authorizing", reason: null,
    };
    const published = (): void => this.onStatus({ ...status, handled: [...status.handled] });
    const change = (state: CoordinationStatus["state"], reason: string | null = null): void => {
      if (status.state !== state || status.reason !== reason) { status.state = state; status.reason = reason; published(); }
    };
    published();
    let currentId = initial.id;
    const touched = new Set<string>();
    let ownsRunningTask = false;
    const authorized = (): boolean => !signal.aborted && Date.now() < this.grant.expiresAt;
    try {
      while (authorized()) {
        const tasks = await this.api.list();
        if (!authorized()) break;
        const task = tasks.find((entry) => entry.id === currentId);
        if (!task || task.owner !== initial.owner || (task.id === initial.id && task.message !== initial.message)) {
          change("blocked", "task_identity_changed"); break;
        }
        if (this.grant.allowedMessages && !this.grant.allowedMessages.includes(task.message)) { change("blocked", "task_outside_authorized_messages"); break; }
        if (["failed", "rejected", "interrupted"].includes(task.state)) { change("blocked", "task_" + task.state); break; }
        if (status.activeTaskId !== task.id) { status.activeTaskId = task.id; published(); }
        // Recheck the whole accepted lineage, including late sibling requests.
        // A fork is not an instruction to execute both branches.
        if (status.handled.some((id) => tasks.filter((entry) => entry.owner === initial.owner && entry.parentId === id && entry.state !== "rejected").length > 1)) {
          change("blocked", "ambiguous_followups"); break;
        }
        if (task.state === "completed") {
          ownsRunningTask = false;
          if (!task.resultReleased) await this.api.release(task.id);
          if (!status.handled.includes(task.id)) { status.handled.push(task.id); published(); }
          if (status.handled.length >= this.grant.maxTasks) { change("limit_reached"); break; }
          if (!this.grant.allowFollowups) { change("stopped", "followups_not_authorized"); break; }
          const children = tasks.filter((entry) => entry.owner === initial.owner && entry.parentId === task.id && entry.state !== "rejected");
          if (children.length > 1) { change("blocked", "ambiguous_followups"); break; }
          if (children.length === 1) { currentId = children[0].id; continue; }
          change("waiting_for_chatgpt");
        } else if (task.state === "pending" || task.state === "approved") {
          if (tasks.some((entry) => entry.state === "running" && entry.id !== task.id)) { change("blocked", "another_task_is_running"); break; }
          // Reserve the round before invoking a mutating API. Never retry an
          // ambiguous run acknowledgement by starting the same task again.
          if (touched.has(task.id)) { change("blocked", "ambiguous_run_state"); break; }
          touched.add(task.id);
          if (task.state === "pending") await this.api.approve(task.id);
          if (!authorized()) break;
          // Mark ownership before the request: a lost acknowledgement must
          // trigger reconciliation/cancellation, never an automatic rerun.
          ownsRunningTask = true;
          await this.api.run(task.id);
          change("running");
        } else if (task.state === "running") {
          // Adopting an already-running root is explicit in the local grant.
          ownsRunningTask = true;
          const approvals = await this.api.approvals(task.id);
          change(approvals.length ? "waiting_for_user" : "running", approvals.length ? "codex_approval_required" : null);
        }
        await pause(signal, this.grant.expiresAt, this.pollMs);
      }
      if (signal.aborted) change("stopped", "local_stop");
      else if (Date.now() >= this.grant.expiresAt && !["blocked", "limit_reached", "stopped"].includes(status.state)) change("expired");
    } catch {
      change("blocked", "local_api_or_audit_error");
    } finally {
      if (ownsRunningTask && status.activeTaskId) {
        try {
          const task = (await this.api.list()).find((entry) => entry.id === status.activeTaskId);
          if (!task) throw new Error("Task disappeared during cancellation");
          if (task.state === "running") await this.api.cancel(task.id);
        } catch {
          // Even if read-back fails, make one best-effort stop request. Still
          // report uncertainty; do not claim host cancellation was confirmed.
          try { await this.api.cancel(status.activeTaskId); } catch { /* reported below */ }
          status.reason = "cancellation_unconfirmed"; status.state = "blocked"; published();
        }
      }
    }
    return { ...status, handled: [...status.handled] };
  }
}

/** Arms an exact new root without requiring the operator to copy task UUIDs. */
export class GoalTaskCoordinator {
  constructor(private readonly api: CoordinatorApi, private readonly grant: GoalCoordinationGrant,
    private readonly onStatus: (status: CoordinationStatus) => void = () => {}, private readonly pollMs = 1000) {
    goalGrantSchema.parse(grant); validateExpiry(grant.expiresAt);
    if (grant.allowedMessages && !grant.allowedMessages.includes(grant.goal)) throw new Error("Goal is outside the permitted task messages");
  }

  async supervise(signal: AbortSignal): Promise<CoordinationStatus> {
    const sessionId = randomUUID();
    let status: CoordinationStatus = { sessionId, rootTaskId: null, owner: this.grant.owner, goal: this.grant.goal,
      expiresAt: this.grant.expiresAt, maxTasks: this.grant.maxTasks, handled: [], activeTaskId: null, state: "authorizing", reason: null };
    const publish = (state: CoordinationStatus["state"], reason: string | null = null): void => {
      status = { ...status, state, reason }; this.onStatus({ ...status, handled: [...status.handled] });
    };
    const authorized = (): boolean => !signal.aborted && Date.now() < this.grant.expiresAt;
    publish("authorizing");
    try {
      // Capture BEFORE announcing readiness. Old pending/retried tasks are not
      // automatically adopted by a fresh local authorization.
      const baseline = new Set((await this.api.list()).map((task) => task.id));
      if (authorized()) publish("waiting_for_task");
      while (authorized()) {
        const tasks = await this.api.list();
        if (!authorized()) break;
        const matches = tasks.filter((task) => !baseline.has(task.id) && task.owner === this.grant.owner &&
          task.parentId === null && task.message === this.grant.goal);
        if (matches.length > 1) { publish("blocked", "ambiguous_root_tasks"); return status; }
        if (matches.length === 1) {
          if (matches[0].state !== "pending") { publish("blocked", "root_task_not_pending"); return status; }
          return await new TaskCoordinator(this.api, { rootTaskId: matches[0].id, maxTasks: this.grant.maxTasks,
            expiresAt: this.grant.expiresAt, allowFollowups: this.grant.allowFollowups, allowedMessages: this.grant.allowedMessages },
          (update) => { status = update; this.onStatus(update); }, this.pollMs, sessionId,
          { owner: this.grant.owner, message: this.grant.goal }).supervise(signal);
        }
        await pause(signal, this.grant.expiresAt, this.pollMs);
      }
      publish(signal.aborted ? "stopped" : "expired", signal.aborted ? "local_stop" : null);
    } catch {
      publish("blocked", "local_api_or_audit_error");
    }
    return status;
  }
}
