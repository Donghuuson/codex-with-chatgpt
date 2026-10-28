import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type RpcMessage = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };

/** JSON-RPC transport for a single owned App Server process. */
export class AppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;
  private buffer = "";

  constructor(command: string, args: string[], private readonly onEvent: (event: RpcMessage) => void = () => {}, private readonly onServerRequest?: (event: RpcMessage) => void, private readonly onFailure: (error: Error) => void = () => {}) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/token|secret|password|api_key|credential/i.test(key)));
    this.process = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env, detached: process.platform !== "win32" });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > 2_000_000) { this.failAll("App Server response too large"); this.close(); return; }
        this.receive(line);
        if (this.closed) return;
      }
      if (Buffer.byteLength(this.buffer) > 2_000_000) { this.failAll("App Server response too large"); this.close(); }
    });
    // Do not forward stderr: it may contain sensitive local data.
    this.process.stderr.resume();
    this.process.on("error", () => this.failAll("App Server could not start"));
    this.process.on("exit", () => this.failAll("App Server exited"));
    this.process.stdin.on("error", () => this.failAll("App Server input closed"));
  }

  private receive(line: string): void {
    let msg: RpcMessage;
    try { msg = JSON.parse(line) as RpcMessage; if (!msg || typeof msg !== "object") throw new Error(); } catch { this.failAll("Invalid App Server response"); this.close(); return; }
    if (msg.method && msg.id !== undefined) {
      try {
        if (!this.onServerRequest) throw new Error("Interactive approval is unavailable");
        this.onServerRequest(msg);
      } catch {
        this.send({ id: msg.id, error: { code: -32601, message: "Unsupported server request" } });
      }
      return;
    }
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "App Server request failed"));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      try { this.onEvent(msg); } catch { this.failAll("App Server event handling failed"); this.close(); }
    }
  }

  private send(message: unknown): void {
    if (this.closed) throw new Error("App Server is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(message: string): void {
    const wasClosed = this.closed;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear();
    if (!wasClosed) this.onFailure(new Error(message));
  }

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("App Server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("App Server request timed out")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "c2c_bridge", title: "Codex with ChatGPT", version: "0.1.3" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized", params: {} });
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  close(): void {
    this.failAll("App Server closed");
    this.buffer = "";
    try {
      if (process.platform !== "win32" && this.process.pid) process.kill(-this.process.pid, "SIGTERM");
      else this.process.kill();
    } catch { /* Process already exited. */ }
  }
}
