import { describe, expect, it } from "vitest";
import { TaskQueue } from "../src/execution/task-queue.js";
import { TaskRunner } from "../src/execution/task-runner.js";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

const server = `
const readline = require('node:readline');
const send = o => console.log(JSON.stringify(o));
readline.createInterface({input:process.stdin}).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send({id:msg.id,result:{}});
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') send({id:msg.id,result:{thread:{id:'thread-1'}}});
  if (msg.method === 'turn/start') {
    send({id:msg.id,result:{turn:{id:'turn-1'}}});
    send({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',command:'test'}});
  }
  if (msg.id === 99 && msg.result) {
    send({method:'item/completed',params:{threadId:'thread-1',item:{type:'agentMessage',text:'reviewed result'}}});
    send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});
  }
});`;

describe("experimental task runner", () => {
  it("fails promptly when its process cannot start", async () => {
    const queue = new TaskQueue();
    const task = queue.submit("a", "Inspect");
    queue.transition(task.id, "pending", "approved");
    const runner = new TaskRunner(queue, process.cwd(), path.join(os.tmpdir(), `missing-codex-${randomUUID()}`), [], { testTransport: true, timeoutMs: 1000 });
    await runner.run("a", task.id);
    expect(queue.get("a", task.id)).toMatchObject({ state: "failed", failureStage: "initializing" });
    expect(runner.canRun()).toBe(true);
  });
  it("ends a silent process at the task deadline", async () => {
    const queue = new TaskQueue();
    const task = queue.submit("a", "Inspect");
    queue.transition(task.id, "pending", "approved");
    const runner = new TaskRunner(queue, process.cwd(), process.execPath, ["-e", "setInterval(()=>{},1000)"], { testTransport: true, timeoutMs: 100 });
    await runner.run("a", task.id);
    expect(queue.get("a", task.id).state).toBe("failed");
    expect(runner.canRun()).toBe(true);
  });
  it("rejects a workspace missing in the runner environment without starting a task", async () => {
    const queue = new TaskQueue();
    const task = queue.submit("a", "Inspect");
    queue.transition(task.id, "pending", "approved");
    const missing = path.join(os.tmpdir(), `c2c-missing-${randomUUID()}`);
    const runner = new TaskRunner(queue, missing, process.execPath, ["-e", server], { testTransport: true });
    await expect(runner.run("a", task.id)).rejects.toThrow("Workspace directory is not accessible");
    expect(queue.get("a", task.id).state).toBe("approved");
  });
  it("requires approval, runs, keeps results private, and resumes a follow-up", async () => {
    const queue = new TaskQueue();
    const runner = new TaskRunner(queue, process.cwd(), process.execPath, ["-e", server], { testTransport: true });
    const first = queue.submit("a", "Inspect");
    await expect(runner.run("a", first.id)).rejects.toThrow("not runnable");
    queue.transition(first.id, "pending", "approved");
    const execute = async (id: string): Promise<void> => {
      const running = runner.run("a", id);
      await viWait(() => runner.approvals(id)?.list().length === 1);
      runner.approvals(id)?.decide(99, "accept");
      await running;
    };
    await execute(first.id);
    const completed = queue.get("a", first.id);
    expect(completed.state).toBe("completed");
    expect(completed.resultReleased).toBe(false);
    expect(completed.result).toBe("reviewed result");
    expect(completed.threadId).toBe("thread-1");
    queue.releaseResult(first.id);
    expect(queue.get("a", first.id).resultReleased).toBe(true);
    const followup = queue.submit("a", "Revise", first.id);
    queue.transition(followup.id, "pending", "approved");
    await execute(followup.id);
    expect(queue.get("a", followup.id).threadId).toBe("thread-1");
  });
});

async function viWait(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for approval");
}
