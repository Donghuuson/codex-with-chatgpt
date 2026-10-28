import { describe, expect, it, vi } from "vitest";
import { TaskCoordinator, type CoordinatorApi, type CoordinationGrant, type CoordinationStatus } from "../src/execution/coordinator.js";
import { TaskQueue } from "../src/execution/task-queue.js";

function harness() {
  const queue = new TaskQueue();
  const controller = new AbortController();
  const root = queue.submit("client", "Goal");
  const states: CoordinationStatus[] = [];
  const api: CoordinatorApi = {
    list: vi.fn(async () => queue.list()),
    approve: vi.fn(async (id) => { queue.transition(id, "pending", "approved"); }),
    run: vi.fn(async (id) => { queue.transition(id, "approved", "running"); }),
    release: vi.fn(async (id) => { queue.releaseResult(id); }),
    cancel: vi.fn(async (id) => { queue.transition(id, "running", "interrupted"); }),
    approvals: vi.fn(async () => []),
  };
  const grant: CoordinationGrant = { rootTaskId: root.id, maxTasks: 3, expiresAt: Date.now() + 2000, allowFollowups: true };
  const finish = (id: string) => queue.transition(id, "running", "completed", "Result");
  const supervise = (onStatus?: (status: CoordinationStatus) => void) => new TaskCoordinator(api, grant, (status) => { states.push(status); onStatus?.(status); }, 1).supervise(controller.signal);
  return { queue, controller, root, states, api, grant, finish, supervise };
}

describe("bounded local coordinator", () => {
  it("runs/releases a linear chain automatically and leaves unrelated tasks untouched", async () => {
    const h = harness();
    const unrelated = h.queue.submit("client", "Unrelated root");
    const otherOwner = h.queue.submit("other", "Another owner");
    h.api.run = vi.fn(async (id) => { h.queue.transition(id, "approved", "running"); h.finish(id); });
    const release = h.api.release;
    h.api.release = vi.fn(async (id) => {
      await release(id);
      if (h.queue.list().filter((task) => task.owner === "client" && task.id !== unrelated.id).length < 3) h.queue.submit("client", "Revision", id);
    });
    const result = await h.supervise();
    expect(result.state).toBe("limit_reached");
    expect(result.handled).toHaveLength(3);
    expect(h.api.run).toHaveBeenCalledTimes(3);
    expect(h.api.release).toHaveBeenCalledTimes(3);
    expect(h.queue.get("client", unrelated.id).state).toBe("pending");
    expect(h.queue.get("other", otherOwner.id).state).toBe("pending");
    expect(h.api.cancel).not.toHaveBeenCalled();
  });

  it("can supervise an already completed root without rerunning it", async () => {
    const h = harness();
    h.queue.transition(h.root.id, "pending", "approved"); h.queue.transition(h.root.id, "approved", "running"); h.finish(h.root.id);
    h.grant.allowFollowups = false;
    expect((await h.supervise()).reason).toBe("followups_not_authorized");
    expect(h.api.run).not.toHaveBeenCalled();
    expect(h.queue.get("client", h.root.id).resultReleased).toBe(true);
  });

  it("blocks ambiguous children before running either", async () => {
    const h = harness();
    h.api.run = vi.fn(async (id) => {
      h.queue.transition(id, "approved", "running"); h.finish(id);
      h.queue.submit("client", "Left", id); h.queue.submit("client", "Right", id);
    });
    expect((await h.supervise()).reason).toBe("ambiguous_followups");
    expect(h.api.run).toHaveBeenCalledTimes(1);
  });

  it("never grants a Codex escalation and cancels on local stop", async () => {
    const h = harness();
    h.api.approvals = vi.fn(async () => [{ id: "approval" }]);
    const result = await h.supervise((status) => { if (status.state === "waiting_for_user") h.controller.abort(); });
    expect(h.states.some((status) => status.reason === "codex_approval_required")).toBe(true);
    expect(result.reason).toBe("local_stop");
    expect(h.api.cancel).toHaveBeenCalledWith(h.root.id);
    expect(h.queue.get("client", h.root.id).state).toBe("interrupted");
  });

  it("detects a late sibling while a descendant is running", async () => {
    const h = harness(); let child = "";
    h.api.run = vi.fn(async (id) => {
      h.queue.transition(id, "approved", "running");
      if (id === h.root.id) { h.finish(id); child = h.queue.submit("client", "First revision", id).id; }
      else h.queue.submit("client", "Late alternative", h.root.id);
    });
    expect((await h.supervise()).reason).toBe("ambiguous_followups");
    expect(h.api.cancel).toHaveBeenCalledWith(child);
    expect(h.api.run).toHaveBeenCalledTimes(2);
  });

  it("refuses a follow-up outside the approved exact messages", async () => {
    const h = harness(); h.grant.allowedMessages = ["Goal"];
    h.api.run = vi.fn(async (id) => { h.queue.transition(id, "approved", "running"); h.finish(id); h.queue.submit("client", "Unapproved revision", id); });
    expect((await h.supervise()).reason).toBe("task_outside_authorized_messages");
    expect(h.api.approve).toHaveBeenCalledTimes(1);
  });

  it("stops if the audit callback fails during execution", async () => {
    const h = harness(); let failed = false;
    expect((await h.supervise((status) => {
      if (status.state === "running" && !failed) { failed = true; throw new Error("disk full"); }
    })).reason).toBe("local_api_or_audit_error");
    expect(h.api.cancel).toHaveBeenCalledWith(h.root.id);
  });

  it("stops and cancels at expiry", async () => {
    const h = harness(); h.grant.expiresAt = Date.now() + 30;
    expect((await h.supervise()).state).toBe("expired");
    expect(h.api.cancel).toHaveBeenCalledTimes(1);
  });

  it("does not start work if the local stop arrives during approval", async () => {
    const h = harness();
    h.api.approve = vi.fn(async (id) => { h.queue.transition(id, "pending", "approved"); h.controller.abort(); });
    expect((await h.supervise()).reason).toBe("local_stop");
    expect(h.api.run).not.toHaveBeenCalled();
  });

  it("fails closed and cancels an accepted run with a lost response without retry", async () => {
    const h = harness();
    h.api.run = vi.fn(async (id) => { h.queue.transition(id, "approved", "running"); throw new Error("response lost"); });
    expect((await h.supervise()).reason).toBe("local_api_or_audit_error");
    expect(h.api.run).toHaveBeenCalledTimes(1);
    expect(h.api.cancel).toHaveBeenCalledWith(h.root.id);
  });

  it("reports an unconfirmed cancellation when the local API is unavailable", async () => {
    const h = harness();
    h.api.run = vi.fn(async (id) => { h.queue.transition(id, "approved", "running"); });
    h.api.cancel = vi.fn(async () => { throw new Error("offline"); });
    expect((await h.supervise((status) => { if (status.state === "running") h.controller.abort(); })).reason).toBe("cancellation_unconfirmed");
  });

  it("enforces exact diagnostic messages before approving", async () => {
    const h = harness(); h.grant.allowedMessages = ["Other goal"];
    expect((await h.supervise()).reason).toBe("task_outside_authorized_messages");
    expect(h.api.approve).not.toHaveBeenCalled();
  });

  it.each(["failed", "rejected", "interrupted"] as const)("stops on %s", async (state) => {
    const h = harness();
    if (state === "rejected") h.queue.transition(h.root.id, "pending", state);
    else { h.queue.transition(h.root.id, "pending", "approved"); h.queue.transition(h.root.id, "approved", "running"); h.queue.transition(h.root.id, "running", state); }
    expect((await h.supervise()).reason).toBe(`task_${state}`);
    expect(h.api.approve).not.toHaveBeenCalled();
  });

  it("does not compete with a different running task", async () => {
    const h = harness(); const other = h.queue.submit("other", "Busy");
    h.queue.transition(other.id, "pending", "approved"); h.queue.transition(other.id, "approved", "running");
    expect((await h.supervise()).reason).toBe("another_task_is_running");
    expect(h.api.cancel).not.toHaveBeenCalled();
  });

  it("requires explicit bounded authorization", () => {
    const h = harness();
    for (const extra of [{ maxTasks: 0 }, { maxTasks: 13 }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 3_600_100 }]) {
      expect(() => new TaskCoordinator(h.api, { ...h.grant, ...extra })).toThrow();
    }
  });
});
