import { describe, expect, it } from "vitest";
import { type ProxyProbe, proxyDoctorCheck } from "../../src/provider/proxy.js";

const probe = (overrides: Partial<ProxyProbe>): ProxyProbe => ({
  env: {},
  execArgv: [],
  allowedFlags: new Set(["--use-env-proxy"]),
  nodeVersion: "v22.22.1",
  platform: "darwin",
  fileExists: () => true,
  ...overrides,
});

describe("proxyDoctorCheck", () => {
  it("says nothing when no proxy or CA is configured", () => {
    expect(proxyDoctorCheck(probe({}))).toBeUndefined();
  });

  it("reports a process the launcher started with the flag", () => {
    expect(
      proxyDoctorCheck(
        probe({
          env: { https_proxy: "http://p:1", NO_PROXY: "localhost,127.0.0.1,[::1]" },
          execArgv: ["--use-env-proxy"],
        }),
      ),
    ).toEqual({
      name: "proxy",
      ok: true,
      detail: "requests use https_proxy; NO_PROXY=localhost,127.0.0.1,[::1]",
    });
    const viaEnv = proxyDoctorCheck(probe({ env: { HTTP_PROXY: "http://p", NODE_USE_ENV_PROXY: "1" } }));
    expect(viaEnv?.detail).toBe("requests use HTTP_PROXY; no NO_PROXY: loopback is proxied too");
    expect(viaEnv?.warn).toBeUndefined();
  });

  it("warns when the proxy is set but fetch will not use it", () => {
    const dev = proxyDoctorCheck(probe({ env: { HTTPS_PROXY: "http://p" } }));
    expect(dev).toMatchObject({ warn: true, detail: expect.stringContaining("not started with --use-env-proxy") });
    expect(dev?.fixHint).toContain("seekforge");

    const optedOut = proxyDoctorCheck(probe({ env: { HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "0" } }));
    expect(optedOut?.fixHint).toContain("other than 1");

    const flagOff = proxyDoctorCheck(
      probe({ env: { HTTPS_PROXY: "http://p", NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "--no-use-env-proxy" } }),
    );
    expect(flagOff?.warn).toBe(true);

    const windows = proxyDoctorCheck(probe({ env: { HTTPS_PROXY: "http://p" }, platform: "win32" }));
    expect(windows?.fixHint).toContain("NODE_USE_ENV_PROXY=1");

    const oldNode = proxyDoctorCheck(
      probe({ env: { HTTPS_PROXY: "http://p" }, allowedFlags: new Set(), nodeVersion: "v20.20.1" }),
    );
    expect(oldNode).toMatchObject({ warn: true, detail: expect.stringContaining("Node v20.20.1 cannot") });
  });

  it("explains ALL_PROXY and a missing CA bundle", () => {
    expect(proxyDoctorCheck(probe({ env: { all_proxy: "socks5://p" } }))?.detail).toContain("does not read it");
    expect(
      proxyDoctorCheck(probe({ env: { NODE_EXTRA_CA_CERTS: "/nope.pem" }, fileExists: () => false })),
    ).toMatchObject({ warn: true, detail: "NODE_EXTRA_CA_CERTS points to a missing file (/nope.pem)" });
    expect(proxyDoctorCheck(probe({ env: { NODE_EXTRA_CA_CERTS: "/ca.pem" } }))?.detail).toBe(
      "no proxy; extra CA certificates from NODE_EXTRA_CA_CERTS",
    );
  });
});
