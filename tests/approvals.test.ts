import { describe, expect, it, vi } from "vitest";
import { ApprovalBroker } from "../src/execution/approvals.js";

describe("local approval broker", () => {
  it("waits for a decision and rejects replay", () => {
    const respond = vi.fn();
    const broker = new ApprovalBroker(respond);
    broker.request({ id: 1, method: "item/commandExecution/requestApproval", params: { command: "test" } });
    expect(respond).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
    broker.decide(1, "accept");
    expect(respond).toHaveBeenCalledWith(1, { decision: "accept" });
    expect(() => broker.decide(1, "accept")).toThrow();
  });

  it("denies unknown requests and pending requests on cancellation", () => {
    const respond = vi.fn();
    const broker = new ApprovalBroker(respond);
    expect(() => broker.request({ id: 2, method: "unknown" })).toThrow("Unsupported");
    broker.request({ id: 3, method: "item/fileChange/requestApproval" });
    broker.cancelAll();
    expect(respond).toHaveBeenCalledWith(3, { decision: "decline" });
    expect(broker.list()).toHaveLength(0);
  });
});
