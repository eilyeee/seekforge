"use strict";

// A tiny reverse-Polish-notation evaluator with two seeded bugs:
//   1. subtraction pops its operands in the wrong order (a - b vs b - a),
//   2. division is not implemented at all (throws "unknown operator").
// The verify command (`npm test`) stays RED until both are fixed, which is the
// run -> verify -> continue loop's success criterion.
function evalRpn(tokens) {
  const stack = [];
  for (const token of tokens) {
    if (typeof token === "number") {
      stack.push(token);
      continue;
    }
    const b = stack.pop();
    const a = stack.pop();
    switch (token) {
      case "+":
        stack.push(a + b);
        break;
      case "-":
        // BUG: should be a - b.
        stack.push(b - a);
        break;
      case "*":
        stack.push(a * b);
        break;
      default:
        // BUG: "/" falls through here and throws.
        throw new Error(`unknown operator: ${token}`);
    }
  }
  return stack.pop();
}

module.exports = { evalRpn };
