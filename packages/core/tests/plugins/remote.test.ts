import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPluginSource,
  describePluginOrigin,
  installPluginFromSource,
  listPlugins,
} from "../../src/plugins/index.js";
import {
  assertListingAgrees,
  assertSafeMemberName,
  cloneShallow,
  downloadArchive,
  listTarEntries,
  listZipEntries,
  MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES,
  redactSourceUrl,
} from "../../src/plugins/source.js";
import {
  cleanupTemps,
  commandAvailable,
  fakeFetch,
  gitIn,
  gitRepo,
  tarBuffer,
  tarGz,
  temp,
  unicodePathExtra,
  useTempHome,
  writePlugin,
  zipBuffer,
} from "./remote-helpers.js";

afterEach(cleanupTemps);

const hasZip = commandAvailable("zip", ["-v"]) && commandAvailable("unzip", ["-v"]);

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function stagingLeftovers(home: string): string[] {
  const root = path.join(home, ".seekforge", "plugins");
  return fs.existsSync(root) ? fs.readdirSync(root).filter((name) => name.startsWith(".staging-")) : [];
}

describe("classifyPluginSource", () => {
  const none = () => false;
  it.each([
    ["https://github.com/acme/tools.git", { kind: "git", url: "https://github.com/acme/tools.git" }],
    ["https://github.com/acme/tools", { kind: "git", url: "https://github.com/acme/tools" }],
    [
      "https://github.com/acme/tools.git#v1.2.0",
      { kind: "git", url: "https://github.com/acme/tools.git", ref: "v1.2.0" },
    ],
    ["ssh://git@host.example/acme/tools.git", { kind: "git", url: "ssh://git@host.example/acme/tools.git" }],
    ["git@github.com:acme/tools.git#main", { kind: "git", url: "git@github.com:acme/tools.git", ref: "main" }],
    ["file:///srv/mirror/tools", { kind: "git", url: "file:///srv/mirror/tools" }],
    [
      "https://example.com/dl/tools-1.0.0.tar.gz?token=x",
      { kind: "archive", url: "https://example.com/dl/tools-1.0.0.tar.gz?token=x", format: "tar.gz" },
    ],
    ["https://example.com/tools.TGZ", { kind: "archive", url: "https://example.com/tools.TGZ", format: "tar.gz" }],
    ["https://example.com/tools.zip", { kind: "archive", url: "https://example.com/tools.zip", format: "zip" }],
    ["tools@acme", { kind: "marketplace", plugin: "tools", marketplace: "acme" }],
  ])("classifies %s", (spec, expected) => {
    expect(classifyPluginSource(spec, { exists: none })).toEqual(expected);
  });

  it("treats anything else, and any existing path, as a local directory", () => {
    expect(classifyPluginSource("./plugins/tools", { cwd: "/w", exists: none })).toEqual({
      kind: "local",
      path: path.resolve("/w", "plugins/tools"),
    });
    expect(classifyPluginSource("tools@acme", { cwd: "/w", exists: () => true })).toEqual({
      kind: "local",
      path: path.resolve("/w", "tools@acme"),
    });
    // Not a valid id pair, so not a marketplace reference either.
    expect(classifyPluginSource("Tools@Acme", { cwd: "/w", exists: none }).kind).toBe("local");
  });

  it.each([
    ["http://example.com/tools.git", /unencrypted http/],
    ["git://example.com/tools.git", /unencrypted git/],
    ["ext::sh -c touch% /tmp/pwned", /unsupported plugin source scheme "ext"/],
    ["ftp://example.com/tools.tar.gz", /unsupported plugin source scheme "ftp"/],
    ["--upload-pack=touch /tmp/x", /must not start with "-"/],
    ["https://example.com/tools.zip#main", /archive URL takes no #ref/],
    ["https://github.com/acme/tools.git#--evil", /invalid git ref/],
    ["https://github.com/acme/tools.git#a..b", /invalid git ref/],
    ["", /empty/],
  ])("rejects %s", (spec, message) => {
    expect(() => classifyPluginSource(spec, { exists: none })).toThrow(message);
  });
});

describe("archive member tables", () => {
  it("accepts regular files and directories, including pax and GNU long names", () => {
    const long = `${"d".repeat(120)}/file.txt`;
    const pax = Buffer.from(`${String(`path=${long}\n`.length + 4).padStart(2, "0")} path=${long}\n`);
    const entries = listTarEntries(
      tarBuffer([
        { name: "pkg/", type: "5", mode: 0o755 },
        { name: "pkg/plugin.json", content: "{}" },
        { name: "././@LongLink", type: "L", content: `pkg/${"x".repeat(150)}.md\0` },
        { name: "pkg/truncated", content: "long" },
        { name: "PaxHeader", type: "x", content: pax.toString() },
        { name: "pkg/short", content: "pax" },
      ]),
    );
    expect(entries).toEqual([
      { name: "pkg/", type: "directory", size: 0 },
      { name: "pkg/plugin.json", type: "file", size: 2 },
      { name: `pkg/${"x".repeat(150)}.md`, type: "file", size: 4 },
      { name: long, type: "file", size: 3 },
    ]);
  });

  it.each([
    [[{ name: "../evil", content: "x" }], /escapes the archive/],
    [[{ name: "pkg/../../evil", content: "x" }], /escapes the archive/],
    [[{ name: "/etc/evil", content: "x" }], /absolute path/],
    [[{ name: "pkg/link", type: "2", linkname: "/etc/passwd" }], /contains a link/],
    [[{ name: "pkg/hard", type: "1", linkname: "pkg/plugin.json" }], /contains a link/],
    [[{ name: "pkg/fifo", type: "6" }], /unsupported type/],
    [[{ name: "pkg/tool", content: "x", mode: 0o4755 }], /set-id/],
    [[{ name: "pkg\\evil", content: "x" }], /backslash/],
    [
      [
        { name: "PaxHeader", type: "x", content: "21 path=../../escape\n" },
        { name: "ok", content: "x" },
      ],
      /escapes/,
    ],
    [[{ name: "Global", type: "g", content: "16 path=renamed\n" }], /global pax header/],
  ])("rejects a crafted tar (%#)", (members, message) => {
    expect(() => listTarEntries(tarBuffer(members))).toThrow(message);
  });

  it("refuses members their owner could not read or clean up", () => {
    expect(() => listTarEntries(tarBuffer([{ name: "pkg/", type: "5", mode: 0o500 }]))).toThrow(/not accessible/);
    expect(() => listTarEntries(tarBuffer([{ name: "pkg/secret", content: "x", mode: 0o044 }]))).toThrow(
      /not accessible/,
    );
  });

  it("parses hand-built zips: modes, hosts without modes, and the Unicode path field unzip prefers", () => {
    expect(
      listZipEntries(
        zipBuffer([
          { name: "pkg/", mode: 0o040755 },
          { name: "pkg/plugin.json", content: "{}" },
          { name: "dos.txt", content: "x", host: 0, mode: 0 },
        ]),
      ),
    ).toEqual([
      { name: "pkg/", type: "directory", size: 0 },
      { name: "pkg/plugin.json", type: "file", size: 2 },
      { name: "dos.txt", type: "file", size: 1 },
    ]);
    expect(() => listZipEntries(zipBuffer([{ name: "pkg/link", content: "/etc", mode: 0o120777 }]))).toThrow(
      /link or special file/,
    );
    expect(() => listZipEntries(zipBuffer([{ name: "../evil", content: "x" }]))).toThrow(/escapes/);
    expect(() =>
      listZipEntries(zipBuffer([{ name: "benign.txt", content: "x", extra: unicodePathExtra("../../evil") }])),
    ).toThrow(/escapes/);
    expect(() => listZipEntries(Buffer.from("not a zip"))).toThrow(/not a zip archive/);
  });

  it("rejects a corrupted header rather than walking misaligned data", () => {
    const tar = tarBuffer([{ name: "pkg/plugin.json", content: "{}" }]);
    tar[0] = "q".charCodeAt(0);
    expect(() => listTarEntries(tar)).toThrow(/checksum/);
  });

  it("requires the extracting tool's listing to agree with the parsed table", () => {
    const parsed = [
      { name: "pkg/", type: "directory" as const, size: 0 },
      { name: "pkg/a", type: "file" as const, size: 1 },
    ];
    expect(() => assertListingAgrees(parsed, ["pkg/", "pkg/a"])).not.toThrow();
    expect(() => assertListingAgrees(parsed, ["pkg/"])).toThrow(/disagrees/);
    expect(() => assertListingAgrees(parsed, ["pkg/", "pkg/b"])).toThrow(/disagrees/);
    // Tools escape non-ASCII names in their own ways; only the count binds there.
    expect(() => assertListingAgrees([{ name: "pkg/é", type: "file", size: 1 }], ["pkg/\\303\\251"])).not.toThrow();
  });

  it("refuses unsafe member names", () => {
    for (const name of ["", "C:/evil", "a/\u0001b", "x\0y"]) expect(() => assertSafeMemberName(name)).toThrow();
    expect(() => assertSafeMemberName("pkg/..hidden/ok")).not.toThrow();
  });

  it.runIf(hasZip)("reads a zip central directory and refuses symlink members", () => {
    const dir = temp("seekforge-zip-src-");
    fs.mkdirSync(path.join(dir, "pkg"));
    fs.writeFileSync(path.join(dir, "pkg", "a.txt"), "hello");
    execFileSync("zip", ["-qr", "ok.zip", "pkg"], { cwd: dir });
    expect(listZipEntries(fs.readFileSync(path.join(dir, "ok.zip")))).toEqual([
      { name: "pkg/", type: "directory", size: 0 },
      { name: "pkg/a.txt", type: "file", size: 5 },
    ]);
    fs.symlinkSync("/etc/passwd", path.join(dir, "pkg", "link"));
    execFileSync("zip", ["-qry", "bad.zip", "pkg"], { cwd: dir });
    expect(() => listZipEntries(fs.readFileSync(path.join(dir, "bad.zip")))).toThrow(/link or special file/);
  });
});

describe("downloadArchive", () => {
  it("follows https redirects by hand and refuses a hop to http", async () => {
    const body = Buffer.from("payload");
    const fetch = fakeFetch({
      "https://example.com/a.tgz": () => new Response(null, { status: 302, headers: { location: "/b.tgz" } }),
      "https://example.com/b.tgz": () => new Response(body),
      "https://example.com/insecure.tgz": () =>
        new Response(null, { status: 301, headers: { location: "http://example.com/b.tgz" } }),
    });
    const result = await downloadArchive("https://example.com/a.tgz", { fetch });
    expect(result.body.toString()).toBe("payload");
    expect(result.sha256).toBe(sha256(body));
    expect(fetch.calls).toEqual(["https://example.com/a.tgz", "https://example.com/b.tgz"]);
    await expect(downloadArchive("https://example.com/insecure.tgz", { fetch })).rejects.toThrow(/non-https/);
    await expect(downloadArchive("http://example.com/b.tgz", { fetch })).rejects.toThrow(/non-https/);
  });

  it("refuses a response that ended on http after the platform followed redirects", async () => {
    const response = new Response("x");
    Object.defineProperty(response, "url", { value: "http://mirror.example.com/a.tgz" });
    const fetch = fakeFetch({ "https://example.com/a.tgz": () => response });
    await expect(downloadArchive("https://example.com/a.tgz", { fetch })).rejects.toThrow(/non-https/);
  });

  it("stops reading once the body exceeds the cap and reports HTTP failures", async () => {
    const fetch = fakeFetch({
      "https://example.com/big.tgz": () => new Response(Buffer.alloc(64)),
      "https://example.com/gone.tgz": () => new Response("no", { status: 410 }),
    });
    await expect(downloadArchive("https://example.com/big.tgz", { fetch, maxBytes: 16 })).rejects.toThrow(/exceeds/);
    await expect(downloadArchive("https://example.com/gone.tgz", { fetch })).rejects.toThrow(/HTTP 410/);
  });
});

describe("installPluginFromSource: git", () => {
  it("clones shallowly, records the pinned commit, strips .git, and installs disabled", async () => {
    const home = useTempHome();
    const repo = gitRepo(path.join(temp("seekforge-git-src-"), "tools"), (dir) => writePlugin(dir, "git-tools"));
    const result = await installPluginFromSource(repo.url);
    expect(result.manifest.id).toBe("git-tools");
    expect(result.origin).toEqual({ kind: "git", url: repo.url, commit: repo.head });
    expect(fs.existsSync(path.join(result.path, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(result.path, "plugin.json"))).toBe(true);
    const record = listPlugins(temp("seekforge-ws-")).find((plugin) => plugin.id === "git-tools");
    expect(record?.status).toBe("disabled");
    expect(record?.origin).toEqual(result.origin);
    expect(describePluginOrigin(result.origin)).toBe(`git ${repo.url} @ ${repo.head}`);
    expect(stagingLeftovers(home)).toEqual([]);

    await expect(installPluginFromSource(repo.url)).rejects.toThrow(/already installed/);
    expect(stagingLeftovers(home)).toEqual([]);
  });

  it("checks out the requested #ref and requires force to update", async () => {
    useTempHome();
    const dir = path.join(temp("seekforge-git-ref-"), "tools");
    const repo = gitRepo(dir, (d) => writePlugin(d, "ref-tools", "1.0.0"));
    gitIn(dir, ["checkout", "-q", "-b", "next"]);
    writePlugin(dir, "ref-tools", "2.0.0");
    gitIn(dir, ["commit", "-q", "-am", "next"]);
    const nextHead = gitIn(dir, ["rev-parse", "HEAD"]);
    gitIn(dir, ["checkout", "-q", "main"]);

    const first = await installPluginFromSource(repo.url);
    expect(first.manifest.version).toBe("1.0.0");
    const updated = await installPluginFromSource(`${repo.url}#next`, { force: true });
    expect(updated.updated).toBe(true);
    expect(updated.manifest.version).toBe("2.0.0");
    expect(updated.origin).toEqual({ kind: "git", url: repo.url, ref: "next", commit: nextHead });
  });

  it("fetches a pinned commit that is not the tip, and fails when it cannot", async () => {
    const dir = path.join(temp("seekforge-git-sha-"), "tools");
    const repo = gitRepo(dir, (d) => writePlugin(d, "sha-tools", "1.0.0"));
    writePlugin(dir, "sha-tools", "1.1.0");
    gitIn(dir, ["commit", "-q", "-am", "tip"]);
    gitIn(dir, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const target = path.join(temp("seekforge-git-sha-dst-"), "checkout");
    await expect(cloneShallow(repo.url, target, { sha: repo.head })).resolves.toBe(repo.head);
    expect(JSON.parse(fs.readFileSync(path.join(target, "plugin.json"), "utf8")).version).toBe("1.0.0");
    const missing = path.join(temp("seekforge-git-sha-miss-"), "checkout");
    await expect(cloneShallow(repo.url, missing, { sha: "0".repeat(40) })).rejects.toThrow();
  });

  it("surfaces a failed clone and leaves nothing staged", async () => {
    const home = useTempHome();
    const missing = `file://${path.join(temp("seekforge-git-missing-"), "nope")}`;
    await expect(installPluginFromSource(missing)).rejects.toThrow(/git clone failed \(exit \d+\)/);
    expect(stagingLeftovers(home)).toEqual([]);
  });
});

describe("installPluginFromSource: archives", () => {
  function pluginTarGz(id: string, wrapper = "acme-tools-1a2b3c/"): Buffer {
    return tarGz([
      { name: wrapper, type: "5", mode: 0o755 },
      {
        name: `${wrapper}plugin.json`,
        content: JSON.stringify({
          apiVersion: 1,
          id,
          name: id,
          version: "1.0.0",
          contributes: { skillRoots: ["skills"] },
        }),
      },
      { name: `${wrapper}skills/`, type: "5", mode: 0o755 },
      { name: `${wrapper}skills/README.md`, content: "# skills\n" },
    ]);
  }

  it("installs a tar.gz (descending into a single wrapper directory) and records its sha256", async () => {
    const home = useTempHome();
    const body = pluginTarGz("tar-tools");
    const fetch = fakeFetch({ "https://example.com/tools.tar.gz": () => new Response(body) });
    const result = await installPluginFromSource("https://example.com/tools.tar.gz", { fetch });
    expect(result.manifest.id).toBe("tar-tools");
    expect(result.origin).toEqual({ kind: "archive", url: "https://example.com/tools.tar.gz", sha256: sha256(body) });
    expect(fs.readFileSync(path.join(result.path, "skills", "README.md"), "utf8")).toBe("# skills\n");
    expect(listPlugins(temp("seekforge-ws-")).find((plugin) => plugin.id === "tar-tools")?.status).toBe("disabled");
    expect(stagingLeftovers(home)).toEqual([]);
  });

  it("never writes a crafted member: traversal and link archives fail before extraction", async () => {
    const home = useTempHome();
    const outside = temp("seekforge-archive-outside-");
    const fetch = fakeFetch({
      "https://example.com/escape.tgz": () => new Response(tarGz([{ name: "../../pwned", content: "x" }])),
      "https://example.com/link.tgz": () =>
        new Response(
          tarGz([
            { name: "pkg/link", type: "2", linkname: outside },
            { name: "pkg/link/pwned", content: "x" },
          ]),
        ),
    });
    await expect(installPluginFromSource("https://example.com/escape.tgz", { fetch })).rejects.toThrow(/escapes/);
    await expect(installPluginFromSource("https://example.com/link.tgz", { fetch })).rejects.toThrow(/link/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(stagingLeftovers(home)).toEqual([]);
  });

  it("refuses a decompression bomb before anything reaches disk", async () => {
    useTempHome();
    const bomb = gzipSync(Buffer.alloc(MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES + 1024));
    const fetch = fakeFetch({ "https://example.com/bomb.tgz": () => new Response(bomb) });
    await expect(installPluginFromSource("https://example.com/bomb.tgz", { fetch })).rejects.toThrow(/expands beyond/);
  });

  it("refuses an archive whose contents are not a plugin", async () => {
    useTempHome();
    const fetch = fakeFetch({
      "https://example.com/empty.tgz": () => new Response(tarGz([{ name: "README.md", content: "hi" }])),
    });
    await expect(installPluginFromSource("https://example.com/empty.tgz", { fetch })).rejects.toThrow(/plugin\.json/);
  });

  it.runIf(hasZip)("installs a zip archive", async () => {
    useTempHome();
    const src = temp("seekforge-zip-plugin-");
    writePlugin(path.join(src, "zip-tools"), "zip-tools");
    execFileSync("zip", ["-qr", "tools.zip", "zip-tools"], { cwd: src });
    const body = fs.readFileSync(path.join(src, "tools.zip"));
    const fetch = fakeFetch({ "https://example.com/tools.zip": () => new Response(body) });
    const result = await installPluginFromSource("https://example.com/tools.zip", { fetch });
    expect(result.manifest.id).toBe("zip-tools");
    expect(result.origin).toEqual({ kind: "archive", url: "https://example.com/tools.zip", sha256: sha256(body) });
  });

  it("refuses credentials in an archive URL without echoing them", async () => {
    useTempHome();
    const fetch = fakeFetch({});
    const failure = installPluginFromSource("https://user:hunter2@example.com/t.tgz", { fetch });
    await expect(failure).rejects.toThrow("archive URLs cannot carry credentials: https://example.com/t.tgz");
    expect(fetch.calls).toEqual([]);
  });

  it("strips credentials from a recorded git URL", () => {
    expect(redactSourceUrl("https://user:hunter2@git.example.com/acme/tools.git")).toBe(
      "https://git.example.com/acme/tools.git",
    );
    expect(redactSourceUrl("git@github.com:acme/tools.git")).toBe("git@github.com:acme/tools.git");
  });
});

describe("installPluginFromSource: local", () => {
  it("records the local origin", async () => {
    useTempHome();
    const src = path.join(temp("seekforge-local-src-"), "local-tools");
    writePlugin(src, "local-tools");
    const result = await installPluginFromSource(src);
    expect(result.origin).toEqual({ kind: "local", path: src });
  });
});
