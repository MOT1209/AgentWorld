import { describe, it, expect } from "vitest";
import {
  ACTION_RISK,
  ALWAYS_APPROVE_ACTIONS,
} from "../packages/approvals/src/approval-policy.js";
import {
  ApprovalPolicyEngine,
  createDefaultPolicyEngine,
  policyEngine,
  setPolicyEngine,
} from "../packages/approvals/src/index.js";

describe("policy engine contract", () => {
  it("allows routine actions", () => {
    const engine = createDefaultPolicyEngine();
    for (const action of ["task.create", "plan.get", "wallet.balance", "session.start", "review.submit"]) {
      expect(engine.evaluate({ action }).verdict).toBe("ALLOW");
    }
  });

  it("requires approval for always-approve actions", () => {
    const engine = createDefaultPolicyEngine();
    for (const action of ["agent.create", "wallet.withdraw", "company.structure.modify"]) {
      const result = engine.evaluate({ action });
      expect(result.verdict).toBe("REQUIRE_APPROVAL");
      expect(result.risk).toBe("CRITICAL");
    }
  });

  it("gates transfers on the spend threshold", () => {
    const engine = createDefaultPolicyEngine({ spendThresholdMinor: 1000 });
    expect(engine.evaluate({ action: "wallet.transfer", amountMinor: 999 }).verdict).toBe("ALLOW");
    expect(engine.evaluate({ action: "wallet.transfer", amountMinor: 1000 }).verdict).toBe("REQUIRE_APPROVAL");
    // The amount verdict claims the whole action: declared risk cannot
    // override a below-threshold transfer (mirrors evaluateApproval).
    expect(
      engine.evaluate({ action: "wallet.transfer", amountMinor: 10, declaredRisk: "HIGH" }).verdict,
    ).toBe("ALLOW");
  });

  it("honors declared HIGH/CRITICAL risk", () => {
    const engine = createDefaultPolicyEngine();
    expect(engine.evaluate({ action: "task.create", declaredRisk: "HIGH" }).verdict).toBe("REQUIRE_APPROVAL");
    expect(engine.evaluate({ action: "task.create", declaredRisk: "LOW" }).verdict).toBe("ALLOW");
    expect(engine.evaluate({ action: "approval.decide", declaredRisk: "CRITICAL" }).verdict).toBe(
      "REQUIRE_APPROVAL",
    );
  });

  it("denies unknown actions (fail closed)", () => {
    const result = createDefaultPolicyEngine().evaluate({ action: "frobnicate.widgets" });
    expect(result.verdict).toBe("DENY");
    expect(result.risk).toBe("HIGH");
  });

  it("applies first-wins precedence and exposes the seam", () => {
    const engine = new ApprovalPolicyEngine()
      .register("first", () => ({ verdict: "ALLOW" as const, reason: "first", risk: "LOW" as const }))
      .register("second", () => ({ verdict: "DENY" as const, reason: "second", risk: "HIGH" as const }));
    expect(engine.evaluate({ action: "anything" }).reason).toBe("first");
    expect(engine.ruleNames()).toEqual(["first", "second"]);

    setPolicyEngine(engine);
    expect(policyEngine()).toBe(engine);
    setPolicyEngine(null);
    expect(policyEngine().ruleNames()).toContain("always-approve-list");
  });

  it("stays aligned with the canonical approval-policy tables", () => {
    const engine = createDefaultPolicyEngine();
    for (const [action, risk] of Object.entries(ACTION_RISK)) {
      if (risk !== "LOW") continue;
      expect(engine.evaluate({ action }).verdict).toBe("ALLOW");
    }
    for (const action of ALWAYS_APPROVE_ACTIONS) {
      expect(engine.evaluate({ action }).verdict).toBe("REQUIRE_APPROVAL");
    }
  });
});
