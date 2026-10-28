import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import { startDashboard, type Dashboard } from "../src/dashboard/server.js";
import { createDashboardSource, type DashboardSnapshot } from "../src/dashboard/source.js";
import { startBridge } from "../src/bridge/server.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

export const emptySnapshot = (): DashboardSnapshot => ({ workspace: { id: "fixture", name: "Synthetic workspace" },
  connection: { online: true, executionEnabled: true, message: "OK" }, tasks: [], sessions: [], events: [], warnings: [], updatedAt: new Date().toISOString() });

async function login(dashboard: Dashboard): Promise<string> {
  const response = await fetch(dashboard.url + "/api/session", { method: "POST", headers: { Origin: dashboard.url, "Content-Type": "application/json" }, body: JSON.stringify({ code: new URL(dashboard.accessUrl).hash.slice(1) }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
  return cookie.split(";")[0];
}

describe("read-only local dashboard", () => {
  const open: Dashboard[] = [];
  afterEach(async () => { await Promise.all(open.splice(0).map((dashboard) => dashboard.close())); vi.restoreAllMocks(); });
  async function viewer(readSnapshot = async () => emptySnapshot()) {
    const dashboard = await startDashboard({ workspaceRoot: process.cwd(), readSnapshot }); open.push(dashboard); return dashboard;
  }
  it("requires separate viewer access, consumes the link once and never puts it in HTML", async () => {
    const dashboard = await viewer();
    expect(new URL(dashboard.url).hostname).toBe("127.0.0.1");
    const page = await fetch(dashboard.url);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).not.toContain(new URL(dashboard.accessUrl).hash.slice(1));
    expect((await fetch(dashboard.url + "/api/snapshot")).status).toBe(401);
    const cookie = await login(dashboard);
    const response = await fetch(dashboard.url + "/api/snapshot", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200); expect((await response.json()).workspace.name).toBe("Synthetic workspace");
    expect((await fetch(dashboard.url + "/api/session", { method: "POST", headers: { Origin: dashboard.url, "Content-Type": "application/json" }, body: JSON.stringify({ code: new URL(dashboard.accessUrl).hash.slice(1) }) })).status).toBe(401);
  });
  it("blocks foreign origins, rebinding hosts and forwarded access even with a viewer cookie", async () => {
    const dashboard = await viewer(); const cookie = await login(dashboard);
    // Node fetch normalizes Host to the URL host; use raw HTTP below to
    // actually deliver a rebinding Host header to the server under test.
    for (const extra of [{ Origin: "https://untrusted.example" }, { "X-Forwarded-For": "127.0.0.1" }, { "Sec-Fetch-Site": "cross-site" }]) {
      expect((await fetch(dashboard.url + "/api/snapshot", { headers: { Cookie: cookie, ...extra } })).status, JSON.stringify(extra)).toBe(403);
    }
    const rebinding = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpGet(dashboard.url + "/api/snapshot", { headers: { Host: "untrusted.example", Cookie: cookie } }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on("error", reject);
    });
    expect(rebinding).toBe(403);
    expect((await fetch(dashboard.url + "/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  });
  it("has no approve/run/release/permission or generic admin proxy routes", async () => {
    const dashboard = await viewer(); const cookie = await login(dashboard);
    for (const route of ["/admin/info", "/admin/tasks", "/api/tasks/run", "/api/tasks/approve", "/api/permissions", "/api/snapshot"]) {
      expect((await fetch(dashboard.url + route, { method: "POST", headers: { Cookie: cookie, Origin: dashboard.url } })).status).toBe(405);
    }
    expect((await fetch(dashboard.url + "/admin/info", { headers: { Cookie: cookie } })).status).toBe(404);
  });
  it("returns generic errors rather than backend credentials or exception text", async () => {
    const dashboard = await viewer(async () => { throw new Error("adminToken=synthetic-private-value"); });
    const cookie = await login(dashboard);
    const response = await fetch(dashboard.url + "/api/snapshot", { headers: { Cookie: cookie } });
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("synthetic-private-value");
  });
  it("handles malformed viewer input without a stack trace", async () => {
    const dashboard = await viewer();
    const response = await fetch(dashboard.url + "/api/session", { method: "POST", headers: { Origin: dashboard.url, "Content-Type": "application/json" }, body: "{" });
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid_request" });
  });
  it("serves static assets without any third-party scripts", async () => {
    const dashboard = await viewer();
    const script = await fetch(dashboard.url + "/dashboard.js");
    expect(script.headers.get("content-type")).toContain("javascript");
    const content = await script.text();
    expect(content).not.toContain("innerHTML"); expect(content).toContain("textContent");
    expect(content).not.toContain("adminToken"); expect(content).not.toContain("/admin/");
  });
  it("expires an unused access link", async () => {
    const dashboard = await viewer();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
    const response = await fetch(dashboard.url + "/api/session", { method: "POST", headers: { Origin: dashboard.url, "Content-Type": "application/json" }, body: JSON.stringify({ code: new URL(dashboard.accessUrl).hash.slice(1) }) });
    expect(response.status).toBe(401);
  });
});

describe("dashboard data projection", () => {
  it("hides unreleased results, strips private fields, reads audit events and never mutates tasks", async () => {
    const state = isolateStateDir(), root = makeTmpDir("dashboard-source"), queue = new TaskQueue();
    const task = queue.submit("client", "Synthetic diagnostic");
    queue.transition(task.id, "pending", "approved"); queue.transition(task.id, "approved", "running"); queue.transition(task.id, "running", "completed", "UNRELEASED_SYNTHETIC_RESULT");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue });
    const id = randomUUID(), dir = path.join(state, "coordination", bridge.workspace.id); fs.mkdirSync(dir, { recursive: true });
    const status = { sessionId: id, rootTaskId: task.id, activeTaskId: task.id, expiresAt: Date.now() + 5000, maxTasks: 2, handled: [task.id], state: "waiting_for_chatgpt", reason: null };
    fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ workspaceId: bridge.workspace.id, grant: { private: "private-grant" }, status }));
    fs.writeFileSync(path.join(dir, id + ".events.jsonl"), JSON.stringify({ at: new Date().toISOString(), status }) + "\n");
    try {
      const snapshot = await createDashboardSource(root)();
      expect(snapshot.connection.online).toBe(true);
      expect(snapshot.tasks[0].result).toBeNull(); expect(snapshot.tasks[0].resultReleased).toBe(false);
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("UNRELEASED_SYNTHETIC_RESULT"); expect(serialized).not.toContain("private-grant"); expect(serialized).not.toContain(bridge.adminToken);
      expect(snapshot.events.some((event) => event.kind === "coordinator")).toBe(true);
      expect(snapshot.sessions[0].sessionId).toBe(id);
      expect(queue.get("client", task.id).resultReleased).toBe(false);
      queue.releaseResult(task.id);
      const released = await createDashboardSource(root)();
      expect(released.tasks[0].result).toBe("UNRELEASED_SYNTHETIC_RESULT");
      expect(released.events.filter((event) => event.kind === "task_state")).toHaveLength(1);
    } finally { await bridge.close(); cleanup(root); cleanup(state); }
  });
  it("reports execution disabled accurately without starting or modifying a bridge", async () => {
    const state = isolateStateDir(), root = makeTmpDir("dashboard-disabled");
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    try {
      const snapshot = await createDashboardSource(root)();
      expect(snapshot.connection).toMatchObject({ online: true, executionEnabled: false });
      expect(snapshot.tasks).toEqual([]);
    } finally { await bridge.close(); cleanup(root); cleanup(state); }
  });
  it("shows a warning for corrupt audit data, not a fabricated success", async () => {
    const state = isolateStateDir(), root = makeTmpDir("dashboard-corrupt");
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    const dir = path.join(state, "coordination", bridge.workspace.id); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, randomUUID() + ".json"), "not-json");
    try {
      const snapshot = await createDashboardSource(root)();
      expect(snapshot.sessions).toEqual([]); expect(snapshot.warnings).toHaveLength(1);
    } finally { await bridge.close(); cleanup(root); cleanup(state); }
  });
  it("shows disconnected state when no bridge exists without auto-starting one", async () => {
    const state = isolateStateDir(), root = makeTmpDir("dashboard-offline");
    try { expect((await createDashboardSource(root)()).connection.online).toBe(false); }
    finally { cleanup(root); cleanup(state); }
  });
  it("marks retained results as stale after losing the bridge", async () => {
    const state = isolateStateDir(), root = makeTmpDir("dashboard-stale"), queue = new TaskQueue();
    queue.submit("client", "Pending diagnostic");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue });
    const source = createDashboardSource(root);
    try {
      expect((await source()).connection.online).toBe(true);
      await bridge.close();
      await new Promise((resolve) => setTimeout(resolve, 1050));
      const stale = await source();
      expect(stale.connection.online).toBe(false);
      expect(stale.tasks).toHaveLength(1); expect(stale.connection.message).toContain("lần đọc gần nhất");
    } finally { cleanup(root); cleanup(state); }
  });
});
