import { describe, expect, it } from "vitest";
import { checkBudget, type BudgetState } from "../budget.js";

const fresh: BudgetState = { warned80: false, warnedOver: false };

describe("checkBudget", () => {
  it("is silent with no budget set or non-positive budgets", () => {
    expect(checkBudget(fresh, 99, undefined)).toEqual({ state: fresh, warning: null });
    expect(checkBudget(fresh, 99, 0)).toEqual({ state: fresh, warning: null });
  });

  it("is silent below 80%", () => {
    expect(checkBudget(fresh, 7.99, 10).warning).toBeNull();
  });

  it("warns once when crossing 80%", () => {
    const first = checkBudget(fresh, 8.5, 10);
    expect(first.warning).toBe("cost $8.50 of $10.00 budget (80%)");
    expect(first.state).toEqual({ warned80: true, warnedOver: false });
    expect(checkBudget(first.state, 9.0, 10).warning).toBeNull(); // idempotent
  });

  it("warns once when crossing 100%", () => {
    const at80 = checkBudget(fresh, 8.5, 10).state;
    const over = checkBudget(at80, 10.25, 10);
    expect(over.warning).toBe("cost budget exceeded: $10.25 of $10.00");
    expect(over.state).toEqual({ warned80: true, warnedOver: true });
    expect(checkBudget(over.state, 12, 10).warning).toBeNull(); // idempotent
  });

  it("jumping straight past 100% emits only the exceeded warning", () => {
    const over = checkBudget(fresh, 15, 10);
    expect(over.warning).toBe("cost budget exceeded: $15.00 of $10.00");
    expect(over.state).toEqual({ warned80: true, warnedOver: true });
    expect(checkBudget(over.state, 16, 10).warning).toBeNull();
  });
});
