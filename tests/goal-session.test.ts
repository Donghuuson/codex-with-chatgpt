import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { TaskRunner } from "../src/execution/task-runner.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const fake = `const r=require('node:readline');const send=x=>console.log(JSON.stringify(x));r.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='initialize')send({id:m.id,result:{}});if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'automatic-thread'}}});if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({method:'item/completed',params:{threadId:'automatic-thread',item:{type:'agentMessage',text:'REPORT_OK'}}});send({method:'turn/completed',params:{threadId:'automatic-thread',turn:{id:'turn',status:'completed'}}});}});`;
const cliFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli/index.ts");
function start(root: string, goal: string, maxTasks = 1) {
  const child = spawn(process.execPath, ["--import", "tsx", cliFile, "tasks", "start", "--goal", goal,
    "--max-tasks", String(maxTasks), "--minutes", "1", "--allow-followups", "--json", "-w", root], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (buffer) => { stdout += buffer; }); child.stderr.on("data", (buffer) => { stderr += buffer; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  return { child, exit, output: () => stdout, error: () => stderr };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 250; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("Expected goal session state did not arrive");
}
async function stop(child: ChildProcess, exit: Promise<number | null>): Promise<void> { if (child.exitCode === null) child.kill("SIGTERM"); await exit; }

describe("ID-free local session command", () => {
  it("authorizes once before submission, lets the client manage IDs, runs and releases two turns", async () => {
    const state = isolateStateDir(), root = makeTmpDir("goal-cli"), queue = new TaskQueue();
    const runner = new TaskRunner(queue, root, process.execPath, ["-e", fake], { testTransport: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue, taskRunner: runner });
    const token = bridge.authStore.issueTokens({ clientId: "client", scopes: ["task.submit", "offline_access"] }).accessToken;
    const client = new Client({ name: "goal-review", version: "1" });
    const goal = "Read the allowed report tests without editing files.";
    const session = start(root, goal, 2);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args }); expect(result.isError).not.toBe(true);
      return JSON.parse((result.content as { text: string }[])[0].text);
    };
    try {
      await until(() => session.output().includes('"state":"waiting_for_task"'));
      expect(queue.list()).toHaveLength(0);
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      // No task ID or old parent is supplied by the local operator.
      const first = await call("task_submit", { message: goal });
      await until(() => queue.get("client", first.id).resultReleased === true);
      expect((await call("task_status", { id: first.id })).result).toBe("REPORT_OK");
      // Only the client handles the returned ID internally for its revision.
      const second = await call("task_submit", { message: "Review the previous output without edits", parent_id: first.id });
      await until(() => queue.get("client", second.id).resultReleased === true);
      expect(await session.exit).toBe(0);
      const records = session.output().trim().split("\n").map((line) => JSON.parse(line));
      expect(records.at(-1)).toMatchObject({ rootTaskId: first.id, state: "limit_reached", handled: [first.id, second.id] });
      expect(new Set(records.map((record) => record.sessionId)).size).toBe(1);
      expect(queue.get("client", second.id).threadId).toBe(queue.get("client", first.id).threadId);
      const files = fs.readdirSync(path.join(state, "coordination", bridge.workspace.id));
      expect(files.filter((file) => file.endsWith(".json"))).toHaveLength(1);
      expect(files).not.toContain("active.lock");
    } finally { await stop(session.child, session.exit); await client.close(); await bridge.close(); cleanup(root); cleanup(state); }
  });
  it("fails closed when multiple authorized connections exist", async () => {
    const state = isolateStateDir(), root = makeTmpDir("goal-multiple"), queue = new TaskQueue();
    const runner = new TaskRunner(queue, root, process.execPath, ["-e", fake], { testTransport: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue, taskRunner: runner });
    bridge.authStore.issueTokens({ clientId: "one", scopes: ["task.submit"] });
    bridge.authStore.issueTokens({ clientId: "two", scopes: ["task.submit"] });
    const session = start(root, "Do not pick a connection automatically");
    try {
      expect(await session.exit).toBe(1);
      expect(session.error() + session.output()).toContain("Multiple task-authorized connections");
      expect(queue.list()).toEqual([]);
    } finally { await stop(session.child, session.exit); await bridge.close(); cleanup(root); cleanup(state); }
  });
  it("fails closed with no task grant instead of picking a read-only connection", async () => {
    const state = isolateStateDir(), root = makeTmpDir("goal-no-client"), queue = new TaskQueue();
    const runner = new TaskRunner(queue, root, process.execPath, ["-e", fake], { testTransport: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, taskQueue: queue, taskRunner: runner });
    bridge.authStore.issueTokens({ clientId: "reader", scopes: ["workspace.read"] });
    const session = start(root, "Do not grant execution to this reader");
    try {
      expect(await session.exit).toBe(1);
      expect(session.error() + session.output()).toContain("No task-authorized connection");
      expect(queue.list()).toEqual([]);
    } finally { await stop(session.child, session.exit); await bridge.close(); cleanup(root); cleanup(state); }
  });
});
