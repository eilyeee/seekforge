import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

const roots: string[] = [];
const previousHome = process.env.SEEKFORGE_HOME;

export function temp(prefix: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

export function useTempHome(): string {
  const home = temp("seekforge-remote-home-");
  process.env.SEEKFORGE_HOME = home;
  return home;
}

export function cleanupTemps(): void {
  if (previousHome === undefined) delete process.env.SEEKFORGE_HOME;
  else process.env.SEEKFORGE_HOME = previousHome;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

export function writePlugin(dir: string, id: string, version = "1.0.0", extra: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugin.json"),
    `${JSON.stringify({ apiVersion: 1, id, name: id, version, contributes: { skillRoots: ["skills"] } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, "skills", "README.md"), `# ${id} ${version}\n`);
  for (const [rel, content] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } },
  ).trim();
}

/** A committed repository; returns its `file://` URL and HEAD. */
export function gitRepo(dir: string, populate: (dir: string) => void): { url: string; head: string } {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, ["init", "-q", "-b", "main"]);
  populate(dir);
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-q", "-m", "init"]);
  return { url: `file://${dir}`, head: gitIn(dir, ["rev-parse", "HEAD"]) };
}

export function commandAvailable(command: string, probe: string[] = ["-v"]): boolean {
  const result = spawnSync(command, probe, { stdio: "ignore" });
  return result.error === undefined;
}

type TarMember = { name: string; type?: string; content?: string; mode?: number; linkname?: string };

function tarHeader(member: TarMember, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(member.name, 0, 100, "utf8");
  block.write(`${(member.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, "ascii");
  block.write("0000000\0", 108, "ascii");
  block.write("0000000\0", 116, "ascii");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
  block.write("00000000000\0", 136, "ascii");
  block.write("        ", 148, "ascii");
  block.write(member.type ?? "0", 156, "ascii");
  if (member.linkname) block.write(member.linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "latin1");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return block;
}

/** A hand-built ustar archive, so crafted members are identical on every platform. */
export function tarBuffer(members: TarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const member of members) {
    const data = Buffer.from(member.content ?? "", "utf8");
    parts.push(tarHeader(member, data.length));
    if (data.length > 0) {
      parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

export function tarGz(members: TarMember[]): Buffer {
  return gzipSync(tarBuffer(members));
}

type ZipMember = { name: string; content?: string; mode?: number; host?: number; extra?: Buffer };

/**
 * A stored (uncompressed) zip with hand-set attributes and extra fields. CRCs
 * are left zero: this feeds the member-table parser, not an extractor.
 */
export function zipBuffer(members: ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, "utf8");
    const data = Buffer.from(member.content ?? "", "utf8");
    const extra = member.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(((member.host ?? 3) << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(((member.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    const localRecord = Buffer.concat([local, name, extra, data]);
    locals.push(localRecord);
    centrals.push(Buffer.concat([central, name, extra]));
    offset += localRecord.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** An Info-ZIP Unicode Path extra field (0x7075) naming `unicodeName`. */
export function unicodePathExtra(unicodeName: string): Buffer {
  const name = Buffer.from(unicodeName, "utf8");
  const field = Buffer.alloc(9);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(5 + name.length, 2);
  field.writeUInt8(1, 4);
  return Buffer.concat([field, name]);
}

/** A fetch that serves fixed responses by URL and records what it was asked for. */
export function fakeFetch(routes: Record<string, () => Response>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (init?.redirect !== "manual") throw new Error("downloads must handle redirects manually");
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };
  return Object.assign(impl, { calls }) as typeof fetch & { calls: string[] };
}
