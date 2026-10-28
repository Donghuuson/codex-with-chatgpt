import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeExecutionSettings } from "../src/execution/settings.js";
import { isolateStateDir } from "./helpers.js";
import { AppServerClient } from "../src/execution/app-server.js";
import { executionPolicyArgs, TASK_PROFILE } from "../src/execution/policy.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { TaskRunner } from "../src/execution/task-runner.js";

const binary = process.env.C2C_REAL_CODEX;
describe.skipIf(!binary || process.platform !== "linux")("real Codex execution (explicit opt-in)", () => {
  it("enforces host filesystem and network boundaries", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-real-policy-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "allowed.txt"), "allowed");
    fs.writeFileSync(path.join(root, ".env"), "synthetic-secret");
    fs.writeFileSync(path.join(root, "private.txt"), "synthetic-private");
    fs.writeFileSync(path.join(root, ".c2cignore"), "/private.txt\n");
    fs.writeFileSync(path.join(base, "outside.txt"), "synthetic-outside");
    fs.symlinkSync(path.join(base, "outside.txt"), path.join(root, "outside-link"));
    const listener = net.createServer((socket) => socket.end());
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const client = new AppServerClient(binary!, ["app-server", ...executionPolicyArgs(root, binary!)]);
    try {
      await client.initialize();
      const probe = (command: string[]) => client.request("command/exec", { command, cwd: root, permissionProfile: TASK_PROFILE, timeoutMs: 5000 }) as Promise<{ exitCode: number; stdout: string }>;
      expect((await probe(["/usr/bin/cat", path.join(root, "allowed.txt")])).stdout).toBe("allowed");
      expect((await probe(["/usr/bin/touch", path.join(root, "inside-write")])).exitCode).toBe(0);
      expect(fs.existsSync(path.join(root, "inside-write"))).toBe(true);
      await probe(["/usr/bin/sh", "-c", 'printf changed > "$1"', "probe", path.join(root, ".c2cignore")]);
      expect(fs.readFileSync(path.join(root, ".c2cignore"), "utf8")).toBe("/private.txt\n");
      for (const file of [path.join(root, ".env"), path.join(root, "private.txt"), path.join(base, "outside.txt"), path.join(root, "outside-link")]) {
        expect((await probe(["/usr/bin/cat", file])).exitCode).not.toBe(0);
      }
      await probe(["/usr/bin/sh", "-c", 'printf changed > "$1"', "probe", path.join(base, "outside.txt")]);
      await probe(["/usr/bin/touch", path.join(base, "outside-write")]);
      expect(fs.readFileSync(path.join(base, "outside.txt"), "utf8")).toBe("synthetic-outside");
      expect(fs.existsSync(path.join(base, "outside-write"))).toBe(false);
      const port = (listener.address() as net.AddressInfo).port;
      expect((await probe(["/usr/bin/python3", "-c", "import socket"])).exitCode).toBe(0);
      expect((await probe(["/usr/bin/python3", "-c", `import socket; socket.create_connection(('127.0.0.1',${port}),1)`])).exitCode).not.toBe(0);
    } finally { client.close(); listener.close(); fs.rmSync(base, { recursive: true, force: true }); }
  }, 30_000);

  it("runs a real task and resumes the same real thread", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-real-turn-"));
    const queue = new TaskQueue();
    const runner = new TaskRunner(queue, root, binary!, ["app-server"], { timeoutMs: 90_000 });
    try {
      const first = queue.submit("real-test", "Run a shell command to print C2C_FIRST_OK. Do not read or write files. Report its output.");
      queue.transition(first.id, "pending", "approved");
      await runner.run("real-test", first.id);
      const result = queue.get("real-test", first.id);
      expect(result.state, result.failureStage ?? "").toBe("completed");
      expect(result.result).toContain("C2C_FIRST_OK");
      expect(result.resultReleased).toBe(false);
      queue.releaseResult(first.id);
      const second = queue.submit("real-test", "Reply with C2C_SECOND_OK and the exact marker printed in the previous turn. Do not call tools.", first.id);
      queue.transition(second.id, "pending", "approved");
      await runner.run("real-test", second.id);
      const revised = queue.get("real-test", second.id);
      expect(revised.state, revised.failureStage ?? "").toBe("completed");
      expect(revised.threadId).toBe(result.threadId);
      expect(revised.result).toContain("C2C_SECOND_OK");
      expect(revised.result).toContain("C2C_FIRST_OK");
    } finally { await runner.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 180_000);

  it("completes a real MCP to local CLI to Codex feedback loop", async () => {
    const state = isolateStateDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-real-bridge-"));
    const workspace = new Workspace(root);
    writeExecutionSettings({ workspaceId: workspace.id, root, command: binary!, enabled: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    const client = new Client({ name: "real-mcp-client", version: "1" });
    const token = bridge.authStore.issueTokens({ clientId: "real-client", scopes: ["task.submit"] }).accessToken;
    const cliFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
    const cli = async (...args: string[]) => promisify(execFile)(process.execPath, ["--import", "tsx", cliFile, "tasks", ...args, "-w", root], { timeout: 20_000 });
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as { text: string }[])[0].text) as Record<string, unknown>;
    };
    const reviewAndRun = async (id: string) => {
      await cli("approve", id);
      await cli("run", id);
      let status: Record<string, unknown> = {};
      for (let i = 0; i < 6; i++) {
        status = await call("task_wait", { id, seconds: 20 });
        if (["completed", "failed", "interrupted"].includes(String(status.state))) break;
      }
      expect(status.state, String(status.failureStage)).toBe("completed");
      expect(status.result).toBeNull();
      await cli("release", id);
      return call("task_status", { id });
    };
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const submitted = await call("task_submit", { message: "Run a shell command that prints C2C_BRIDGE_OK. Do not read or write files. Report the printed marker." });
      const result = await reviewAndRun(String(submitted.id));
      expect(result.result).toContain("C2C_BRIDGE_OK");
      const next = await call("task_submit", { message: "Reply C2C_REVIEW_OK and repeat the marker from the previous turn. Do not call tools.", parent_id: submitted.id });
      const reviewed = await reviewAndRun(String(next.id));
      expect(reviewed.result).toContain("C2C_REVIEW_OK");
      expect(reviewed.result).toContain("C2C_BRIDGE_OK");
      const listed = JSON.parse((await cli("list")).stdout) as { tasks: { id: string; threadId: string }[] };
      expect(listed.tasks[0].threadId).toBe(listed.tasks[1].threadId);
    } finally {
      await client.close(); await bridge.close();
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
    }
  }, 240_000);

  it("automates submission, execution, release and revision after one local authorization", async () => {
    const state = isolateStateDir();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-real-coordinator-"));
    // Real Codex setup can materialize these empty metadata/denial paths
    // even on a no-tools turn. Seed them explicitly and assert their contents
    // and the complete directory listing remain unchanged, not just no files
    // matching a marker. No real credentials are present in this fixture.
    const fixtureDirs = [".agents", ".aws", ".codex", ".git"];
    for (const name of fixtureDirs) fs.mkdirSync(path.join(root, name));
    const workspace = new Workspace(root);
    writeExecutionSettings({ workspaceId: workspace.id, root, command: binary!, enabled: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    const client = new Client({ name: "automatic-review-client", version: "1" });
    const token = bridge.authStore.issueTokens({ clientId: "automatic-client", scopes: ["task.submit"] }).accessToken;
    const cliFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
    const firstMessage = "Reply exactly C2C_AUTO_FIRST_OK. Do not use tools or access files.";
    const followupMessage = "Reply C2C_AUTO_SECOND_OK and repeat the exact marker from the previous turn. Do not use tools or access files.";
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      expect(response.isError).not.toBe(true);
      return JSON.parse((response.content as { text: string }[])[0].text) as Record<string, unknown>;
    };
    const released = async (id: string) => {
      for (let i = 0; i < 8; i++) {
        const status = await call("task_wait", { id, seconds: 20 });
        expect(["failed", "rejected", "interrupted"]).not.toContain(status.state);
        if (status.resultAvailable) return status;
      }
      throw new Error("Coordinator did not release the result in time");
    };
    const stop = new AbortController();
    let supervision: Promise<{ stdout: string; stderr: string }> | undefined;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const first = await call("task_submit", { message: firstMessage });
      // The only local authorization in the entire two-turn exchange.
      supervision = promisify(execFile)(process.execPath, ["--import", "tsx", cliFile, "tasks", "supervise", String(first.id),
        "--max-tasks", "2", "--minutes", "3", "--allow-followups", "--allow-message", firstMessage, followupMessage, "-w", root], { timeout: 200_000, signal: stop.signal });
      void supervision.catch(() => {});
      const result = await released(String(first.id));
      expect(result.result).toBe("C2C_AUTO_FIRST_OK");
      // This client reviews the released result and sends a revision directly;
      // no approval, run, release or copied result is supplied by the operator.
      const next = await call("task_submit", { message: followupMessage, parent_id: first.id });
      const reviewed = await released(String(next.id));
      expect(reviewed.result).toContain("C2C_AUTO_SECOND_OK");
      expect(reviewed.result).toContain("C2C_AUTO_FIRST_OK");
      const output = await supervision;
      const statuses = output.stdout.trim().split("\n").map((line) => JSON.parse(line));
      expect(statuses.at(-1)).toMatchObject({ state: "limit_reached", handled: [first.id, next.id] });
      const listed = JSON.parse(fs.readFileSync(path.join(state, "tasks", `${workspace.id}.json`), "utf8"));
      expect(listed[0].threadId).toBe(listed[1].threadId);
      expect(listed.every((task: { resultReleased: boolean }) => task.resultReleased)).toBe(true);
      expect(fs.readdirSync(root)).toEqual(fixtureDirs);
      for (const name of fixtureDirs) expect(fs.readdirSync(path.join(root, name))).toEqual([]);
    } finally {
      stop.abort(); if (supervision) await supervision.catch(() => {});
      await client.close(); await bridge.close();
      fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
    }
  }, 240_000);

  it("binds a real goal and executes a real follow-up without operator task IDs", async () => {
    const state = isolateStateDir(), root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-real-goal-"));
    const workspace = new Workspace(root);
    writeExecutionSettings({ workspaceId: workspace.id, root, command: binary!, enabled: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0 });
    const client = new Client({ name: "goal-client", version: "1" });
    const token = bridge.authStore.issueTokens({ clientId: "goal-client", scopes: ["task.submit", "offline_access"] }).accessToken;
    const goal = "Reply exactly C2C_GOAL_ROOT_OK. Do not use tools or access files.";
    const cliFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
    const child = spawn(process.execPath, ["--import", "tsx", cliFile, "tasks", "start", "--goal", goal,
      "--max-tasks", "2", "--minutes", "3", "--allow-followups", "--json", "-w", root], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { errors += chunk; });
    const ended = new Promise<number | null>((resolve, reject) => { child.on("close", resolve); child.on("error", reject); });
    void ended.catch(() => {});
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    const released = async (id: string) => {
      for (let i = 0; i < 8; i++) {
        const status = await call("task_wait", { id, seconds: 20 });
        expect(["failed", "interrupted", "rejected"], status.failureStage).not.toContain(status.state);
        if (status.resultAvailable) return status;
      }
      throw new Error("No released real worker result");
    };
    try {
      for (let i = 0; i < 500 && !output.includes('"state":"waiting_for_task"'); i++) {
        if (child.exitCode !== null) throw new Error(errors || output);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(output).toContain('"state":"waiting_for_task"');
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const first = await call("task_submit", { message: goal });
      expect((await released(first.id)).result).toBe("C2C_GOAL_ROOT_OK");
      const second = await call("task_submit", { message: "Reply C2C_GOAL_REVIEW_OK followed by the exact marker from the previous turn. Do not use tools or access files.", parent_id: first.id });
      const result = await released(second.id);
      expect(result.result).toContain("C2C_GOAL_ROOT_OK"); expect(result.result).toContain("C2C_GOAL_REVIEW_OK");
      expect(await ended, errors).toBe(0);
      const records = output.trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ state: "limit_reached", rootTaskId: first.id, handled: [first.id, second.id] });
      expect(new Set(records.map((record) => record.sessionId)).size).toBe(1);
      const tasks = JSON.parse(fs.readFileSync(path.join(state, "tasks", workspace.id + ".json"), "utf8"));
      expect(tasks[0].threadId).toBe(tasks[1].threadId);
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM"); await ended.catch(() => {});
      await client.close(); await bridge.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(state, { recursive: true, force: true });
    }
  }, 240_000);
});
