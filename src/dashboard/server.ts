import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { createDashboardSource, type DashboardSnapshot } from "./source.js";
import { DASHBOARD_HTML, DASHBOARD_CSS, DASHBOARD_JS } from "./page.js";

export interface DashboardOptions {
  workspaceRoot: string;
  port?: number;
  /** Dependency injection for tests; not a remote route. */
  readSnapshot?: () => Promise<DashboardSnapshot>;
}
export interface Dashboard {
  url: string;
  /** Single-use viewer access; never contains a bridge credential. */
  accessUrl: string;
  close(): Promise<void>;
}

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const readSnapshot = options.readSnapshot ?? createDashboardSource(options.workspaceRoot);
  const app = express(); app.disable("x-powered-by");
  const bootstrap = randomBytes(32).toString("base64url");
  const bootExpires = Date.now() + 5 * 60_000;
  let bootUsed = false, attempts = 0;
  let viewerCookie = "", viewerExpires = 0;
  let baseUrl = "";
  const cookieName = "c2c_dashboard_" + randomBytes(6).toString("hex");
  const equal = (a: string, b: string): boolean => {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
  };
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" });
    const host = new URL(baseUrl).host;
    if (req.headers.host !== host || Object.keys(req.headers).some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))) {
      res.status(403).json({ error: "local_only" }); return;
    }
    if ((req.headers.origin && req.headers.origin !== baseUrl) || (req.headers["sec-fetch-site"] === "cross-site" && !(req.method === "GET" && req.path === "/"))) {
      res.status(403).json({ error: "origin_not_allowed" }); return;
    }
    next();
  });
  app.get("/", (_req, res) => { res.type("html").send(DASHBOARD_HTML); });
  app.get("/dashboard.css", (_req, res) => { res.type("css").send(DASHBOARD_CSS); });
  app.get("/dashboard.js", (_req, res) => { res.type("application/javascript").send(DASHBOARD_JS); });
  app.post("/api/session", express.json({ limit: "1kb" }), (req, res) => {
    if (req.headers.origin !== baseUrl || !req.is("application/json")) { res.status(403).json({ error: "origin_not_allowed" }); return; }
    if (++attempts > 20) { res.status(429).json({ error: "too_many_attempts" }); return; }
    if (bootUsed || Date.now() >= bootExpires || typeof req.body?.code !== "string" || !equal(req.body.code, bootstrap)) {
      res.status(401).json({ error: "viewer_link_invalid" }); return;
    }
    bootUsed = true; viewerCookie = randomBytes(32).toString("base64url"); viewerExpires = Date.now() + 8 * 60 * 60_000;
    res.setHeader("Set-Cookie", `${cookieName}=${viewerCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
    res.json({ readOnly: true });
  });
  app.get("/api/snapshot", async (req, res) => {
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
    if (!viewerCookie || Date.now() >= viewerExpires || !equal(cookie, viewerCookie)) { res.status(401).json({ error: "viewer_login_required" }); return; }
    try { res.json(await readSnapshot()); }
    catch { res.status(503).json({ error: "snapshot_unavailable" }); }
  });
  app.use((req, res) => { res.status(req.method === "GET" ? 404 : 405).json({ error: "read_only_dashboard" }); });
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: "invalid_request" });
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(options.port ?? 0, "127.0.0.1");
    listening.once("error", reject); listening.once("listening", () => resolve(listening));
  });
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  return { url: baseUrl, accessUrl: `${baseUrl}/#${bootstrap}`,
    close: () => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
