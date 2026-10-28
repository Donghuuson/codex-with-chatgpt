import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getStateDir } from "../config/paths.js";
import { findLiveBridge } from "../bridge/runtime.js";
import { adminFetch } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";

const taskSchema = z.object({
  id: z.string().uuid(), owner: z.string().min(1).max(500), parentId: z.string().uuid().nullable(), message: z.string().max(10_000),
  state: z.enum(["pending", "approved", "running", "completed", "failed", "rejected", "interrupted"]),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  result: z.string().max(100_000).nullable(), resultReleased: z.boolean().optional(),
  threadId: z.string().nullable().optional(), failureStage: z.string().nullable().optional(),
});
const sessionSchema = z.object({
  sessionId: z.string().uuid(), rootTaskId: z.string().uuid().nullable(), activeTaskId: z.string().uuid().nullable(),
  goal: z.string().max(10_000).optional(), owner: z.string().max(500).optional(),
  expiresAt: z.number().finite(), maxTasks: z.number().int().min(1).max(12), handled: z.array(z.string().uuid()).max(12),
  state: z.enum(["authorizing", "waiting_for_task", "running", "waiting_for_chatgpt", "waiting_for_user", "limit_reached", "expired", "stopped", "blocked"]),
  reason: z.string().nullable(),
});
export type DashboardSession = z.infer<typeof sessionSchema>;
export interface DashboardTask extends Omit<z.infer<typeof taskSchema>, "resultReleased"> {
  resultReleased: boolean;
  resultTruncated: boolean;
  approvalCount: number | null;
}
export interface DashboardEvent { id: string; at: string; taskId: string | null; kind: "received" | "task_state" | "coordinator"; state: string; reason: string | null }
export interface DashboardSnapshot {
  workspace: { id: string; name: string };
  connection: { online: boolean; executionEnabled: boolean | null; message: string };
  tasks: DashboardTask[];
  sessions: DashboardSession[];
  events: DashboardEvent[];
  warnings: string[];
  updatedAt: string;
}

/** Bounded local audit reads; never follows a request-supplied path or a symlink. */
function readBounded(file: string, maxBytes: number, tail = false): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (!tail && stat.size > maxBytes)) throw new Error("Invalid audit file");
    const start = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    const count = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, count).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { fs.closeSync(fd); }
}

function history(workspaceId: string): { sessions: DashboardSession[]; events: DashboardEvent[]; warnings: string[] } {
  const dir = path.join(getStateDir(), "coordination", workspaceId);
  const sessions: DashboardSession[] = [], events: DashboardEvent[] = [], warnings: string[] = [];
  if (!fs.existsSync(dir)) return { sessions, events, warnings };
  const files = fs.readdirSync(dir).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => ({ name, time: fs.lstatSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time).slice(0, 20);
  for (const { name } of files) {
    try {
      const saved = z.object({ workspaceId: z.literal(workspaceId), status: sessionSchema }).parse(JSON.parse(readBounded(path.join(dir, name), 256_000)));
      if (saved.status.sessionId !== name.slice(0, -5)) throw new Error("Audit identity mismatch");
      sessions.push(saved.status);
      const log = path.join(dir, name.replace(/\.json$/, ".events.jsonl"));
      if (fs.existsSync(log)) {
        for (const [index, line] of readBounded(log, 256_000, true).trim().split("\n").entries()) {
          try {
            const record = z.object({ at: z.string().datetime(), status: sessionSchema }).parse(JSON.parse(line));
            if (record.status.sessionId !== saved.status.sessionId) throw new Error("Event identity mismatch");
            events.push({ id: `${saved.status.sessionId}:${index}`, at: record.at, taskId: record.status.activeTaskId,
              kind: "coordinator", state: record.status.state, reason: record.status.reason });
          } catch { warnings.push("Một sự kiện điều phối không đọc được; dòng thời gian có thể thiếu."); }
        }
      }
    } catch { warnings.push("Một bản ghi phiên không đọc được; lịch sử có thể thiếu."); }
  }
  return { sessions, events, warnings: [...new Set(warnings)] };
}

/** Only explicit read routes. No generic admin proxy or execution controls. */
export function createDashboardSource(workspaceRoot: string): () => Promise<DashboardSnapshot> {
  const workspace = new Workspace(workspaceRoot);
  let previous: DashboardTask[] = [];
  let pending: Promise<DashboardSnapshot> | null = null;
  let cached: DashboardSnapshot | null = null;
  let cachedAt = 0;
  const load = async (): Promise<DashboardSnapshot> => {
    const audit = history(workspace.id);
    const runtime = await findLiveBridge(workspace.id);
    let tasks = previous;
    const connection: DashboardSnapshot["connection"] = { online: false, executionEnabled: null,
      message: "Không kết nối được cầu nối. Dữ liệu nhiệm vụ bên dưới là lần đọc gần nhất." };
    if (runtime) {
      try {
        const info = await adminFetch<{ executionEnabled: boolean }>(runtime, "GET", "/admin/info", 5000);
        let rawTasks: unknown[] = [];
        try { rawTasks = (await adminFetch<{ tasks: unknown[] }>(runtime, "GET", "/admin/tasks", 5000)).tasks; }
        catch { if (info.executionEnabled) throw new Error("Task API unavailable"); }
        const parsed = z.array(taskSchema).max(100).parse(rawTasks);
        tasks = await Promise.all(parsed.map(async (task): Promise<DashboardTask> => {
          let approvalCount: number | null = 0;
          if (task.state === "running") {
            try { approvalCount = (await adminFetch<{ approvals: unknown[] }>(runtime, "GET", `/admin/tasks/${task.id}/approvals`, 5000)).approvals.length; }
            catch { approvalCount = null; }
          }
          const released = task.resultReleased === true && task.state === "completed";
          return { ...task, result: released ? (task.result?.slice(0, 16_000) ?? null) : null,
            resultReleased: released, resultTruncated: released && (task.result?.length ?? 0) > 16_000, approvalCount };
        }));
        previous = tasks;
        connection.online = true; connection.executionEnabled = info.executionEnabled === true;
        connection.message = "Đang đọc trực tiếp từ cầu nối tại máy.";
      } catch { /* Preserve last successful data, explicitly labelled offline. */ }
    }
    const events = [...audit.events];
    for (const task of tasks) {
      events.push({ id: `${task.id}:received`, at: task.createdAt, taskId: task.id, kind: "received", state: "pending", reason: null });
      if (task.state !== "pending" || task.updatedAt !== task.createdAt) events.push({ id: `${task.id}:latest`, at: task.updatedAt, taskId: task.id, kind: "task_state", state: task.state, reason: task.failureStage ?? null });
    }
    return { workspace: { id: workspace.id, name: workspace.name }, connection,
      tasks: tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), sessions: audit.sessions,
      events: events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 250), warnings: audit.warnings, updatedAt: new Date().toISOString() };
  };
  return async () => {
    if (cached && Date.now() - cachedAt < 1000) return cached;
    if (!pending) pending = load().then((result) => { cached = result; cachedAt = Date.now(); return result; }).finally(() => { pending = null; });
    return pending;
  };
}
