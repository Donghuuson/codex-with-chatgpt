import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../config/paths.js";
import { z } from "zod";

export type TaskState = "pending" | "approved" | "running" | "completed" | "failed" | "rejected" | "interrupted";

export interface TaskRequest {
  id: string;
  owner: string;
  message: string;
  parentId: string | null;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  result: string | null;
  threadId?: string | null;
  resultReleased?: boolean;
  requestId?: string | null;
  failureStage?: string | null;
}

const storedTask = z.object({
  id: z.string().uuid(), owner: z.string().min(1).max(500), message: z.string().min(1).max(10_000),
  parentId: z.string().uuid().nullable(), state: z.enum(["pending", "approved", "running", "completed", "failed", "rejected", "interrupted"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), result: z.string().max(100_000).nullable(),
  threadId: z.string().nullable().optional(), resultReleased: z.boolean().optional(), requestId: z.string().uuid().nullable().optional(),
  failureStage: z.string().max(100).nullable().optional(),
}).refine((task) => !task.resultReleased || (task.state === "completed" && task.result !== null));

/** One instance per bridge. Approval must only be exposed to a local administrator. */
export class TaskQueue {
  private readonly tasks = new Map<string, TaskRequest>();

  constructor(private readonly file?: string) {
    if (!file || !fs.existsSync(file)) return;
    const saved = z.array(storedTask).max(100).parse(JSON.parse(fs.readFileSync(file, "utf8")));
    for (const item of saved) {
      const task = item as TaskRequest;
      if (this.tasks.has(task.id)) throw new Error("Duplicate task ID");
      if (task.state === "running") {
        task.state = "interrupted";
        task.updatedAt = new Date().toISOString();
      }
      this.tasks.set(task.id, task);
    }
    this.persist();
  }

  private persist(): void {
    if (!this.file) return;
    ensureDir(path.dirname(this.file));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify([...this.tasks.values()]), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  submit(owner: string, message: string, parentId: string | null = null, requestId: string | null = null): TaskRequest {
    if (!owner || owner.length > 500 || !message.trim() || message.length > 10_000) throw new Error("Invalid task request");
    if (requestId) {
      z.string().uuid().parse(requestId);
      const previous = [...this.tasks.values()].find((task) => task.owner === owner && task.requestId === requestId);
      if (previous) {
        if (previous.message !== message || previous.parentId !== parentId) throw new Error("Request ID was already used for different content");
        return { ...previous };
      }
    }
    if (this.tasks.size >= 100) throw new Error("Task queue is full");
    if (parentId) {
      const parent = this.get(owner, parentId);
      if (parent.state !== "completed") throw new Error("The previous task is not complete");
    }
    const now = new Date().toISOString();
    const task: TaskRequest = { id: randomUUID(), owner, message, parentId, state: "pending", createdAt: now, updatedAt: now, result: null, threadId: null, resultReleased: false, requestId };
    this.tasks.set(task.id, task);
    try { this.persist(); } catch (error) { this.tasks.delete(task.id); throw error; }
    return { ...task };
  }

  get(owner: string, id: string): TaskRequest {
    const task = this.tasks.get(id);
    if (!task || task.owner !== owner) throw new Error("Task not found");
    return { ...task };
  }

  list(): TaskRequest[] {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  setThread(id: string, threadId: string): void {
    const task = this.tasks.get(id);
    if (!task || task.state !== "running" || !threadId) throw new Error("Invalid task thread");
    const previous = { ...task };
    task.threadId = threadId;
    try { this.persist(); } catch (error) { this.tasks.set(id, previous); throw error; }
  }

  releaseResult(id: string): void {
    const task = this.tasks.get(id);
    if (!task || task.state !== "completed" || task.result === null) throw new Error("Result unavailable");
    const previous = { ...task };
    task.resultReleased = true;
    try { this.persist(); } catch (error) { this.tasks.set(id, previous); throw error; }
  }

  transition(id: string, from: TaskState, to: TaskState, result: string | null = null, failureStage: string | null = null): TaskRequest {
    const task = this.tasks.get(id);
    if (!task || task.state !== from) throw new Error("Invalid task transition");
    const allowed: Record<TaskState, TaskState[]> = { pending: ["approved", "rejected"], approved: ["running", "rejected"], running: ["completed", "failed", "interrupted"], completed: [], failed: [], rejected: [], interrupted: [] };
    if (!allowed[from].includes(to)) throw new Error("Invalid task transition");
    const previous = { ...task };
    task.state = to;
    task.result = result;
    task.failureStage = failureStage;
    task.updatedAt = new Date().toISOString();
    try { this.persist(); } catch (error) { this.tasks.set(id, previous); throw error; }
    return { ...task };
  }
}
