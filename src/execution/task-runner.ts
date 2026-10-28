import fs from "node:fs";
import path from "node:path";
import { AppServerClient, type RpcMessage } from "./app-server.js";
import { ApprovalBroker } from "./approvals.js";
import { TaskQueue } from "./task-queue.js";
import { executionPolicyArgs, TASK_PROFILE } from "./policy.js";

export interface RunnerOptions { testTransport?: boolean; timeoutMs?: number }

/** One serial worker per workspace; remote tools cannot approve or start it. */
export class TaskRunner {
  private active = new Map<string, { client: AppServerClient; approvals: ApprovalBroker; done: Promise<void> }>();
  constructor(private readonly queue: TaskQueue, private readonly cwd: string, private readonly command: string, private readonly args = ["app-server"], private readonly options: RunnerOptions = {}) {}

  approvals(id: string): ApprovalBroker | undefined { return this.active.get(id)?.approvals; }
  canRun(): boolean { return this.active.size === 0; }

  validateWorkspace(): string {
    if (!path.isAbsolute(this.cwd)) throw new Error("Workspace path must be absolute");
    try {
      const root = fs.realpathSync(this.cwd);
      if (!fs.statSync(root).isDirectory()) throw new Error();
      fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
      return root;
    } catch { throw new Error("Workspace directory is not accessible to the Codex process"); }
  }

  cancel(id: string): void { this.active.get(id)?.client.close(); }
  async close(): Promise<void> {
    const running = [...this.active.values()];
    for (const item of running) item.client.close();
    await Promise.allSettled(running.map((item) => item.done));
  }

  run(owner: string, id: string): Promise<void> {
    try {
      const task = this.queue.get(owner, id);
      if (task.state !== "approved" || this.active.size) throw new Error("Task is not runnable");
      const parent = task.parentId ? this.queue.get(owner, task.parentId) : null;
      if (parent && !parent.threadId) throw new Error("Parent thread unavailable");
      const root = this.validateWorkspace();
      const args = this.options.testTransport ? this.args : [...this.args, ...executionPolicyArgs(root, this.command)];
      this.queue.transition(id, "approved", "running");
      let currentThread = "";
      let answer = "";
      let turnId = "";
      let broker!: ApprovalBroker;
      const completions = new Map<string, string>();
      let wake = (): void => {};
      let rejectCompletion!: (error: Error) => void;
      const completed = new Promise<string>((resolve, reject) => {
        rejectCompletion = reject;
        wake = () => { const status = completions.get(turnId); if (status) resolve(status); };
      });
      void completed.catch(() => {});
      const event = (message: RpcMessage): void => {
        const params = message.params as { threadId?: string; turnId?: string; turn?: { id?: string; status?: string }; item?: { type?: string; text?: string } } | undefined;
        if (params?.threadId && params.threadId !== currentThread) return;
        if (message.method === "serverRequest/resolved") {
          const requestId = (message.params as { requestId?: string | number } | undefined)?.requestId;
          if (requestId !== undefined) broker.resolved(requestId);
        }
        if (message.method === "item/completed" && params?.item?.type === "agentMessage" && typeof params.item.text === "string") answer = params.item.text.slice(0, 100_000);
        if (message.method === "turn/completed" && params?.threadId === currentThread && params.turn?.id && params.turn.status) { completions.set(params.turn.id, params.turn.status); wake(); }
      };
      const client = new AppServerClient(this.command, args, event, (message) => {
        const params = message.params as { threadId?: string } | undefined;
        if (params?.threadId !== currentThread) throw new Error("Approval belongs to another thread");
        broker.request(message);
      }, rejectCompletion);
      broker = new ApprovalBroker((requestId, result) => client.respond(requestId, result));
      const timer = setTimeout(() => { rejectCompletion(new Error("Task timed out")); client.close(); }, this.options.timeoutMs ?? 300_000);
      const done = (async (): Promise<void> => {
        let stage = "initializing";
        try {
          await client.initialize();
          const config: Record<string, unknown> = {};
          if (!this.options.testTransport) {
            stage = "loading_config";
            const loaded = await client.request("config/read", {}) as { config?: { mcp_servers?: Record<string, unknown> } };
            for (const name of Object.keys(loaded.config?.mcp_servers ?? {})) config[`mcp_servers.${name}.enabled`] = false;
          }
          const security = this.options.testTransport ? { sandbox: "workspace-write" } : { permissions: TASK_PROFILE };
          stage = "starting_thread";
          const started = await client.request(parent ? "thread/resume" : "thread/start", {
            ...(parent ? { threadId: parent.threadId } : {}), cwd: root, runtimeWorkspaceRoots: [root], approvalPolicy: "on-request", ...security, config,
          }) as { thread?: { id?: string }; activePermissionProfile?: { id?: string } };
          currentThread = started.thread?.id ?? "";
          if (!currentThread || (parent && currentThread !== parent.threadId)) throw new Error("Invalid thread response");
          if (!this.options.testTransport && started.activePermissionProfile?.id !== TASK_PROFILE) throw new Error("Restricted permissions were not activated");
          this.queue.setThread(id, currentThread);
          stage = "starting_turn";
          const result = await client.request("turn/start", {
            threadId: currentThread, input: [{ type: "text", text: task.message }], cwd: root, approvalPolicy: "on-request",
            ...(this.options.testTransport ? {} : { permissions: TASK_PROFILE }),
          }) as { turn?: { id?: string } };
          turnId = result.turn?.id ?? "";
          if (!turnId) throw new Error("Invalid turn response");
          wake();
          stage = "running";
          if (await completed !== "completed") throw new Error("Codex turn did not complete");
          this.queue.transition(id, "running", "completed", answer);
        } catch {
          if (this.queue.get(owner, id).state === "running") this.queue.transition(id, "running", "failed", null, stage);
        } finally {
          clearTimeout(timer);
          try { broker.cancelAll(); } catch { /* Server may already be gone. */ }
          client.close();
          this.active.delete(id);
        }
      })();
      this.active.set(id, { client, approvals: broker, done });
      return done;
    } catch (error) { return Promise.reject(error); }
  }
}
