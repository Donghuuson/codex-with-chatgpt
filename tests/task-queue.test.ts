import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/execution/task-queue.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

describe("task approval queue", () => {
  it("deduplicates retried requests without permitting replacement", () => {
    const queue = new TaskQueue();
    const requestId = randomUUID();
    const task = queue.submit("a", "Inspect", null, requestId);
    expect(queue.submit("a", "Inspect", null, requestId).id).toBe(task.id);
    expect(() => queue.submit("a", "Different", null, requestId)).toThrow("different content");
    expect(queue.list()).toHaveLength(1);
  });
  it("requires approval before a task can complete and rejects replay", () => {
    const queue = new TaskQueue();
    const task = queue.submit("client-a", "Review the report");
    expect(task.state).toBe("pending");
    expect(() => queue.transition(task.id, "pending", "completed")).toThrow();
    expect(() => queue.transition(task.id, "pending", "running")).toThrow();
    queue.transition(task.id, "pending", "approved");
    queue.transition(task.id, "approved", "running");
    expect(() => queue.transition(task.id, "approved", "running")).toThrow();
    expect(queue.transition(task.id, "running", "completed", "done").result).toBe("done");
  });

  it("isolates clients and requires a completed parent for a follow-up", () => {
    const queue = new TaskQueue();
    const task = queue.submit("client-a", "First task");
    expect(() => queue.get("client-b", task.id)).toThrow("Task not found");
    expect(() => queue.submit("client-b", "Follow-up", task.id)).toThrow("Task not found");
    expect(() => queue.submit("client-a", "Follow-up", task.id)).toThrow("not complete");
    queue.transition(task.id, "pending", "approved");
    queue.transition(task.id, "approved", "running");
    queue.transition(task.id, "running", "completed");
    expect(queue.submit("client-a", "Follow-up", task.id).parentId).toBe(task.id);
  });

  it("persists requests and marks running tasks interrupted after restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-task-test-"));
    try {
      const file = path.join(dir, "tasks.json");
      const queue = new TaskQueue(file);
      const task = queue.submit("client-a", "Review");
      queue.transition(task.id, "pending", "approved");
      queue.transition(task.id, "approved", "running");
      const restarted = new TaskQueue(file);
      expect(restarted.get("client-a", task.id).state).toBe("interrupted");
      expect(() => restarted.transition(task.id, "pending", "running")).toThrow();
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("fails closed when stored task data is corrupt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-corrupt-test-"));
    try {
      const file = path.join(dir, "tasks.json");
      fs.writeFileSync(file, JSON.stringify([{ id: "not-a-valid-task", state: "completed", resultReleased: true }]));
      expect(() => new TaskQueue(file)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
