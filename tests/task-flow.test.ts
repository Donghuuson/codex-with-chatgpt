import { describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge } from "../src/bridge/server.js";
import { TaskQueue } from "../src/execution/task-queue.js";
import { TaskRunner } from "../src/execution/task-runner.js";
import { makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";

const fake = `const r=require('node:readline'); const send=x=>console.log(JSON.stringify(x)); r.createInterface({input:process.stdin}).on('line',x=>{const m=JSON.parse(x); if(m.method==='initialize')send({id:m.id,result:{}}); if(m.method==='thread/start'||m.method==='thread/resume')send({id:m.id,result:{thread:{id:'same-thread'}}}); if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn'}}});send({id:88,method:'item/commandExecution/requestApproval',params:{command:'test',threadId:'same-thread'}})} if(m.id===88&&m.result){send({method:'item/completed',params:{item:{type:'agentMessage',text:'result'}}});send({method:'turn/completed',params:{threadId:'same-thread',turn:{id:'turn',status:'completed'}}})}});`;

describe("experimental local task flow", () => {
  it("rejects an inaccessible execution workspace before accepting a run", async () => {
    isolateStateDir();
    const root = makeTmpDir("missing-runner");
    const queue = new TaskQueue();
    const task = queue.submit("client", "Inspect");
    queue.transition(task.id, "pending", "approved");
    const runner = new TaskRunner(queue, path.join(root, "absent"), process.execPath, ["-e", fake], { testTransport: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, taskQueue: queue, taskRunner: runner });
    try {
      const response = await fetch(`${bridge.localBaseUrl()}/admin/tasks/${task.id}/run`, { method: "POST", headers: { authorization: `Bearer ${bridge.adminToken}` } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "workspace_unavailable" });
      expect(queue.get("client", task.id).state).toBe("approved");
    } finally { await bridge.close(); cleanup(root); }
  });
  it("submits, reviews, runs, releases and follows up without exposing admin controls", async () => {
    isolateStateDir();
    const root = makeTmpDir("flow");
    const queue = new TaskQueue(path.join(root, "tasks.json"));
    const runner = new TaskRunner(queue, root, process.execPath, ["-e", fake], { testTransport: true });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false, taskQueue: queue, taskRunner: runner });
    const token = bridge.authStore.issueTokens({ clientId: "client", scopes: ["task.submit"] }).accessToken;
    const client = new Client({ name: "flow", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: object): Promise<Record<string, unknown>> => {
      const result = await client.callTool({ name, arguments: args });
      return JSON.parse((result.content as { text: string }[])[0].text) as Record<string, unknown>;
    };
    const local = async (url: string, method = "POST") => fetch(`${bridge.localBaseUrl()}${url}`, { method, headers: { authorization: `Bearer ${bridge.adminToken}` } });
    try {
      const first = await call("task_submit", { message: "Inspect" });
      const id = String(first.id);
      expect((await local(`/admin/tasks/${id}/run`)).status).toBe(409);
      expect((await local(`/admin/tasks/${id}/approve`)).status).toBe(200);
      expect((await local(`/admin/tasks/${id}/run`)).status).toBe(202);
      for (let i = 0; i < 100 && !runner.approvals(id)?.list().length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await local(`/admin/tasks/${id}/approvals/88/accept`)).status).toBe(200);
      for (let i = 0; i < 100 && queue.get("client", id).state !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect((await call("task_status", { id })).result).toBeNull();
      expect((await local(`/admin/tasks/${id}/release`)).status).toBe(200);
      expect((await call("task_status", { id })).result).toBe("result");
      const followup = await call("task_submit", { message: "Revise", parent_id: id });
      expect(followup.state).toBe("pending");
      expect(queue.get("client", String(followup.id)).parentId).toBe(id);
    } finally { await client.close(); await bridge.close(); cleanup(root); }
  });
});
