import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { startDashboard } from "../src/dashboard/server.js";
import type { DashboardSnapshot } from "../src/dashboard/source.js";

// Uses an explicitly provided, existing Playwright installation. No new runtime
// dependency, browser download, or external browser session is needed.
const playwrightPath = process.env.C2C_PLAYWRIGHT_PATH;
describe.skipIf(!playwrightPath)("dashboard real browser (opt-in)", () => {
  it("renders safely, updates automatically, preserves selection and fits mobile", async () => {
    const { chromium } = await import(pathToFileURL(playwrightPath!).href);
    const browser = await chromium.launch({ headless: true });
    const first = randomUUID(), second = randomUUID(), session = randomUUID(), now = new Date().toISOString();
    const hostile = '<img src=x onerror="window.DASHBOARD_XSS=true"><script>window.DASHBOARD_XSS=true</script>';
    const task = { id: first, owner: "synthetic-client", parentId: null, message: "Synthetic random-code diagnostic " + hostile,
      state: "completed" as const, createdAt: now, updatedAt: now, result: "abcdef1234", resultReleased: true, resultTruncated: false, approvalCount: 0 };
    let snapshot: DashboardSnapshot = {
      workspace: { id: "fixture", name: "Synthetic workspace" }, connection: { online: true, executionEnabled: true, message: "Connected" },
      tasks: [{ ...task, id: second, parentId: first, message: "Convert abcdef1234 to uppercase.", result: "ABCDEF1234" }, task],
      sessions: [{ sessionId: session, rootTaskId: null, goal: "Read report tests without copying task IDs", activeTaskId: null, expiresAt: Date.now() + 600_000, maxTasks: 2, handled: [], state: "waiting_for_task", reason: null }],
      events: [{ id: "received", at: now, taskId: first, kind: "received", state: "pending", reason: null }], warnings: [], updatedAt: now,
    };
    const dashboard = await startDashboard({ workspaceRoot: process.cwd(), readSnapshot: async () => snapshot });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, timezoneId: "Asia/Ho_Chi_Minh" });
    const page = await context.newPage(); const errors: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    try {
      await page.goto(dashboard.accessUrl);
      await page.locator("#connection.online").waitFor();
      expect(new URL(page.url()).hash).toBe("");
      expect(await page.evaluate(() => document.cookie)).toBe("");
      expect(await page.locator("#result-text").textContent()).toBe("ABCDEF1234");
      expect(await page.locator("#sessions").textContent()).toContain("Waiting for a new matching task");
      expect(await page.locator("#sessions").textContent()).toContain("Read report tests without copying task IDs");
      await page.locator("#parent-task").click();
      expect(await page.locator("#request-text").textContent()).toContain(hostile);
      expect(await page.locator("#request-text img").count()).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { DASHBOARD_XSS?: boolean }).DASHBOARD_XSS)).toBeUndefined();
      expect(await page.locator("#timeline li").count()).toBe(1);
      snapshot = { ...snapshot, tasks: snapshot.tasks.map((entry) => entry.id === first ? { ...entry, result: "UPDATED_RESULT" } : entry), updatedAt: new Date().toISOString() };
      await page.waitForFunction(() => document.getElementById("result-text")?.textContent === "UPDATED_RESULT");
      expect(await page.locator(".task-item[aria-pressed=true]").getAttribute("data-task-id")).toBe(first);
      await page.screenshot({ path: path.resolve(".tooling/dashboard-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: path.resolve(".tooling/dashboard-mobile.png"), fullPage: true });
      snapshot = { ...snapshot, connection: { online: false, executionEnabled: null, message: "Last successful data only" }, updatedAt: new Date().toISOString() };
      await page.waitForFunction(() => document.getElementById("connection")?.classList.contains("offline"));
      expect(await page.locator("#notice").textContent()).toContain("Last successful data only");
      expect(errors).toEqual([]);
    } finally { await context.close(); await dashboard.close(); await browser.close(); }
  });
});
