import { describe, expect, it, vi } from "vitest";
import { GoalTaskCoordinator, type CoordinatorApi, type CoordinationStatus, type GoalCoordinationGrant } from "../src/execution/coordinator.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { AuthStore } from "../src/auth/store.js";
import { cleanup, isolateStateDir } from "./helpers.js";

function harness() {
  const queue = new TaskQueue(), controller = new AbortController();
  const states: CoordinationStatus[] = [];
  const grant: GoalCoordinationGrant = { goal: "Inspect the allowed report tests without edits.", owner: "client", maxTasks: 1, expiresAt: Date.now() + 1000, allowFollowups: false };
  const api: CoordinatorApi = {
    list: vi.fn(async () => queue.list()),
    approve: vi.fn(async (id) => { queue.transition(id, "pending", "approved"); }),
    run: vi.fn(async (id) => { queue.transition(id, "approved", "running"); queue.setThread(id, "same-thread"); queue.transition(id, "running", "completed", "OK"); }),
    release: vi.fn(async (id) => { queue.releaseResult(id); }),
    cancel: vi.fn(async (id) => { queue.transition(id, "running", "interrupted"); }),
    approvals: vi.fn(async () => []),
  };
  const run = (notify: (status: CoordinationStatus) => void = () => {}) => new GoalTaskCoordinator(api, grant, (status) => { states.push(status); notify(status); }, 1).supervise(controller.signal);
  return { queue, controller, states, grant, api, run };
}

describe("goal-based root binding without operator task IDs", () => {
  it("waits for a new exact root, binds automatically and uses one session ID", async () => {
    const h = harness(); let root = "";
    const result = await h.run((status) => { if (status.state === "waiting_for_task") root = h.queue.submit("client", h.grant.goal).id; });
    expect(result).toMatchObject({ state: "limit_reached", rootTaskId: root, handled: [root] });
    expect(h.states[0].rootTaskId).toBeNull();
    expect(new Set(h.states.map((state) => state.sessionId)).size).toBe(1);
    expect(h.queue.get("client", root).resultReleased).toBe(true);
    expect(h.api.run).toHaveBeenCalledTimes(1);
  });
  it("ignores old pending jobs, other owners, unrelated goals and children", async () => {
    const h = harness();
    const old = h.queue.submit("client", h.grant.goal);
    h.queue.transition(old.id, "pending", "approved"); h.queue.transition(old.id, "approved", "running"); h.queue.setThread(old.id, "old"); h.queue.transition(old.id, "running", "completed", "old");
    const oldPending = h.queue.submit("client", h.grant.goal);
    let expected = "";
    const result = await h.run((status) => {
      if (status.state === "waiting_for_task") {
        h.queue.submit("other", h.grant.goal); h.queue.submit("client", "Unrelated goal"); h.queue.submit("client", h.grant.goal, old.id);
        expected = h.queue.submit("client", h.grant.goal).id;
      }
    });
    expect(result.rootTaskId).toBe(expected);
    expect(h.queue.get("client", oldPending.id).state).toBe("pending");
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });
  it("does not fuzzy-match or adopt old exact tasks", async () => {
    const h = harness(); h.queue.submit("client", h.grant.goal); h.grant.expiresAt = Date.now() + 35;
    const result = await h.run((status) => { if (status.state === "waiting_for_task") h.queue.submit("client", h.grant.goal + " Also fix any bugs."); });
    expect(result.state).toBe("expired"); expect(h.api.approve).not.toHaveBeenCalled();
  });
  it("refuses multiple new matching roots instead of selecting the newest", async () => {
    const h = harness();
    const result = await h.run((status) => { if (status.state === "waiting_for_task") { h.queue.submit("client", h.grant.goal); h.queue.submit("client", h.grant.goal); } });
    expect(result.reason).toBe("ambiguous_root_tasks"); expect(h.api.run).not.toHaveBeenCalled();
  });
  it("refuses a matching task already running elsewhere", async () => {
    const h = harness();
    const result = await h.run((status) => { if (status.state === "waiting_for_task") { const root = h.queue.submit("client", h.grant.goal); h.queue.transition(root.id, "pending", "approved"); } });
    expect(result.reason).toBe("root_task_not_pending"); expect(h.api.run).not.toHaveBeenCalled();
  });
  it("expires after the original deadline without accepting a queued late task", async () => {
    const h = harness(); h.grant.expiresAt = Date.now() + 35;
    expect((await h.run()).state).toBe("expired"); expect(h.api.run).not.toHaveBeenCalled();
  });
  it("can stop before a root is bound", async () => {
    const h = harness();
    expect((await h.run((status) => { if (status.state === "waiting_for_task") h.controller.abort(); })).reason).toBe("local_stop");
    expect(h.api.cancel).not.toHaveBeenCalled(); expect(h.api.run).not.toHaveBeenCalled();
  });
  it("resumes an automatically bound root for follow-ups, without more local authorization", async () => {
    const h = harness(); h.grant.maxTasks = 2; h.grant.allowFollowups = true;
    const release = h.api.release;
    h.api.release = vi.fn(async (id) => { await release(id); if (h.queue.list().length === 1) h.queue.submit("client", "Review the previous result", id); });
    const result = await h.run((status) => { if (status.state === "waiting_for_task") h.queue.submit("client", h.grant.goal); });
    expect(result.handled).toHaveLength(2); expect(h.api.approve).toHaveBeenCalledTimes(2);
  });
  it("keeps escalation approvals manual after root binding", async () => {
    const h = harness(); h.grant.expiresAt = Date.now() + 40;
    h.api.run = vi.fn(async (id) => { h.queue.transition(id, "approved", "running"); });
    h.api.approvals = vi.fn(async () => [{ id: "extra-access" }]);
    const result = await h.run((status) => { if (status.state === "waiting_for_task") h.queue.submit("client", h.grant.goal); });
    expect(result.state).toBe("expired"); expect(h.states.some((status) => status.state === "waiting_for_user")).toBe(true);
    expect(h.api.cancel).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid bounds or an allowlist that excludes the goal", () => {
    const h = harness();
    for (const update of [{ maxTasks: 13 }, { goal: " " }, { owner: "" }, { allowedMessages: ["Different"] }]) expect(() => new GoalTaskCoordinator(h.api, { ...h.grant, ...update })).toThrow();
  });
});

describe("current authorized client discovery", () => {
  it("deduplicates access/refresh grants and excludes expired, revoked, foreign and read-only tokens", () => {
    const dir = isolateStateDir();
    try {
      const auth = new AuthStore("workspace");
      auth.issueTokens({ clientId: "current", scopes: ["task.submit", "offline_access"] });
      auth.issueTokens({ clientId: "read-only", scopes: ["workspace.read"] });
      auth.issueTokens({ clientId: "expired", scopes: ["task.submit"], accessTtlMs: -1 });
      auth.issueTokens({ clientId: "foreign", scopes: ["task.submit"], workspaceId: "other" });
      const revoked = auth.issueTokens({ clientId: "revoked", scopes: ["task.submit"] }); auth.revokeToken(revoked.accessToken);
      expect(new AuthStore("workspace").authorizedClients("task.submit")).toEqual(["current"]);
    } finally { cleanup(dir); }
  });
});
