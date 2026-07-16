import { describe, expect, it } from "vitest";
import { parseVerifyDiagnostics } from "../../src/agent/verify-diagnostics.js";

describe("parseVerifyDiagnostics", () => {
  it("extracts Vitest failures and locations", () => {
    const result = parseVerifyDiagnostics(
      ` Vitest 2.1.0\n × tests/math.test.ts > math > adds 12ms\nAssertionError: expected 1 to be 2\n at tests/math.test.ts:8:19\n Test Files 1 failed`,
    );
    expect(result.framework).toBe("vitest");
    expect(result.failedTests).toEqual(["tests/math.test.ts > math > adds"]);
    expect(result.diagnostics).toContainEqual({
      file: "tests/math.test.ts",
      line: 8,
      message: "AssertionError: expected 1 to be 2",
    });
  });

  it("extracts Jest failures", () => {
    const result = parseVerifyDiagnostics(
      `FAIL src/sum.test.ts\n  ● sum › adds\n    Error: expected 3\n      at Object.<anonymous> (src/sum.test.ts:11:5)\nTest Suites: 1 failed`,
    );
    expect(result.framework).toBe("jest");
    expect(result.failedTests).toEqual(["src/sum.test.ts", "sum › adds"]);
    expect(result.diagnostics[0]).toMatchObject({ file: "src/sum.test.ts", line: 11 });
  });

  it("extracts Pytest failures and assertion locations", () => {
    const result = parseVerifyDiagnostics(
      `================ FAILURES ================\n________________ test_total _________________\nE assert 1 == 2\ntests/test_math.py:14: AssertionError: assert 1 == 2\n================ short test summary info ================\nFAILED tests/test_math.py::test_total - assert 1 == 2`,
    );
    expect(result.framework).toBe("pytest");
    expect(result.failedTests).toContain("tests/test_math.py::test_total");
    expect(result.diagnostics).toContainEqual({ file: "tests/test_math.py", line: 14, message: "assert 1 == 2" });
  });

  it("extracts Cargo test failures", () => {
    const result = parseVerifyDiagnostics(
      `running 1 test\ntest parser::tests::rejects_empty ... FAILED\nthread 'parser::tests::rejects_empty' panicked at 'expected error', src/parser.rs:42:9\ntest result: FAILED. 0 passed; 1 failed`,
    );
    expect(result.framework).toBe("cargo");
    expect(result.failedTests).toEqual(["parser::tests::rejects_empty"]);
    expect(result.diagnostics).toContainEqual({ file: "src/parser.rs", line: 42, message: "expected error" });
  });

  it("produces a stable fingerprint across timing, ANSI, path separators, and ordering noise", () => {
    const first = parseVerifyDiagnostics(`Vitest\n× b 20ms\n× a 10ms\nError: boom\n at tests\\a.test.ts:7:1`);
    const second = parseVerifyDiagnostics(
      `\u001b[31mVitest\u001b[0m\n× a 99ms\n× b 1ms\nError: boom\n at tests/a.test.ts:7:1`,
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });

  it("bounds results and safely summarizes unknown output", () => {
    const unknown = parseVerifyDiagnostics("line one\nline two\nsecret-ish failure", { maxTextLength: 20 });
    expect(unknown.framework).toBe("unknown");
    expect(unknown.failedTests).toEqual([]);
    expect(unknown.diagnostics).toEqual([]);
    expect(unknown.summary.length).toBeLessThanOrEqual(20);

    const many = parseVerifyDiagnostics(
      `Vitest\n${Array.from({ length: 20 }, (_, i) => `× test ${i}`).join("\n")}\nTest Files 1 failed`,
      { maxFailedTests: 3 },
    );
    expect(many.failedTests).toHaveLength(3);
  });

  it("fingerprints failures beyond the displayed result limit", () => {
    const prefix = Array.from({ length: 20 }, (_, i) => `× test ${i}`).join("\n");
    const first = parseVerifyDiagnostics(`Vitest\n${prefix}\n× hidden failure a\nTest Files 1 failed`);
    const second = parseVerifyDiagnostics(`Vitest\n${prefix}\n× hidden failure b\nTest Files 1 failed`);
    expect(first.failedTests).toHaveLength(20);
    expect(first.failedTests).toEqual(second.failedTests);
    expect(first.fingerprint).not.toBe(second.fingerprint);
  });

  it("retains early failures from a bounded head and tail aggregate", () => {
    const output = `Vitest\n× tests/early.test.ts > fails first\n${"noise\n".repeat(60_000)}Test Files 1 failed`;
    const result = parseVerifyDiagnostics(output);
    expect(result.failedTests).toContain("tests/early.test.ts > fails first");
  });
});
