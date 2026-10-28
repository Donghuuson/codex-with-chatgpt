import type { RpcMessage } from "./app-server.js";

export interface PendingApproval { id: string | number; method: string; params: unknown }

/** Approval state is process-local; pending approvals are never accepted after restart. */
export class ApprovalBroker {
  private readonly pending = new Map<string | number, PendingApproval>();
  constructor(private readonly respond: (id: string | number, result: unknown) => void) {}

  request(message: RpcMessage): void {
    const { id, method, params } = message;
    if (id === undefined || !method) throw new Error("Invalid server request");
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
      throw new Error("Unsupported approval request");
    }
    if (this.pending.has(id)) throw new Error("Duplicate approval ID");
    this.pending.set(id, { id, method, params });
  }

  list(): PendingApproval[] { return [...this.pending.values()]; }
  resolved(id: string | number): void { this.pending.delete(id); }

  decide(id: string | number, decision: "accept" | "decline"): void {
    if (!this.pending.has(id)) throw new Error("Approval not found");
    this.respond(id, { decision });
    this.pending.delete(id);
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.decide(id, "decline");
  }
}
