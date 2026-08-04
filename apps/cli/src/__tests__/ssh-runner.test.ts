import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSshRunArgs, formatSshCommand } from "../ssh-runner.js";
import { shellQuote } from "../runner.js";
import { buildDockerRunArgs } from "../docker-runner.js";
import { createSshRunner } from "../ssh-runner.js";
import { createDockerRunner } from "../docker-runner.js";

/**
 * ssh always runs its command through the remote login shell, so the task text
 * — free-form prose, routinely containing quotes and backticks — is shell input
 * whether anyone wants it to be. These cover the quoting, the security
 * defaults, and the contract both backends now have to satisfy.
 */

const base = { task: "fix the login bug", host: "dev@build-box", workspacePath: "/srv/repo" };

test("a printed --check command is safe to paste into a shell", () => {
  // The whole point of --check is that a human copies it. Rendering it with
  // JSON quotes looks right and executes the backticks in the task the moment
  // it is pasted, because double quotes do not stop command substitution.
  const line = formatSshCommand(buildSshRunArgs({ ...base, task: "fix `whoami`" }));
  assert.equal(line.includes('"'), false);
  assert.match(line, /'cd '\\''\/srv\/repo/);
});

test("quotes a value so the remote shell takes it literally", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // The whole point: none of this can start a command.
  assert.equal(shellQuote("$(rm -rf /)"), "'$(rm -rf /)'");
  assert.equal(shellQuote("`whoami`"), "'`whoami`'");
  assert.equal(shellQuote("a; rm -rf ~"), "'a; rm -rf ~'");
});

test("a task carrying shell syntax stays one argument to the remote run", () => {
  const args = buildSshRunArgs({ ...base, task: "fix `git log`; echo $HOME" });
  const remote = args[args.length - 1]!;
  // Quoted as data. If this ever regressed, the closing quote would move and
  // the trailing text would become commands on someone else's machine.
  assert.match(remote, /run 'fix `git log`; echo \$HOME' -y/);
  assert.equal(remote.startsWith("cd '/srv/repo' && 'seekforge' run "), true);
});

test("never asks for a password, forwards no agent, opens no tty", () => {
  const args = buildSshRunArgs(base);
  // Unattended: a password prompt would hang looking exactly like a slow task.
  assert.ok(args.includes("BatchMode=yes"));
  // Agent forwarding would hand the remote host every key in the local agent.
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("ForwardX11=no"));
  assert.ok(args.includes("RequestTTY=no"));
});

test("never puts an API key on the wire", () => {
  // Docker forwards a secret by NAME because the container shares the host's
  // environment. There is no equivalent here, and sending the value would put
  // it in the remote environment and usually its shell history — so the remote
  // host uses its own credentials and this argv mentions none.
  const args = buildSshRunArgs({ ...base, model: "claude-opus-5" });
  const rendered = formatSshCommand(args);
  for (const name of ["ANTHROPIC_API_KEY", "ARK_API_KEY", "DEEPSEEK_API_KEY", "apiKey"]) {
    assert.equal(rendered.includes(name), false, `${name} must not appear in the ssh command`);
  }
});

test("forwards the run knobs the contract defines", () => {
  const remote = buildSshRunArgs({
    ...base,
    model: "claude-opus-5",
    provider: "anthropic",
    maxCostUsd: 2.5,
    permissionMode: "acceptEdits",
    binary: "/opt/sf/bin/seekforge",
  }).at(-1)!;
  assert.match(remote, /'\/opt\/sf\/bin\/seekforge' run /);
  assert.match(remote, /--max-cost '2\.5'/);
  assert.match(remote, /-m 'claude-opus-5'/);
  assert.match(remote, /--provider 'anthropic'/);
  assert.match(remote, /--permission-mode 'acceptEdits'/);
});

test("passes ssh connection options only when given", () => {
  assert.deepEqual(buildSshRunArgs(base).slice(0, 2), ["-o", "BatchMode=yes"]);
  const withConn = buildSshRunArgs({ ...base, port: 2222, identityFile: "~/.ssh/build" });
  assert.deepEqual(withConn.slice(0, 4), ["-p", "2222", "-i", "~/.ssh/build"]);
});

test("refuses a workspace path it cannot resolve or verify", () => {
  // The path lives on another machine. Resolving it against the local
  // filesystem would silently send the agent somewhere nobody named.
  assert.throws(() => buildSshRunArgs({ ...base, workspacePath: "relative/repo" }), /absolute remote workspace/);
  assert.throws(() => buildSshRunArgs({ ...base, host: "  " }), /requires a host/);
  assert.throws(() => buildSshRunArgs({ ...base, port: 0 }), /between 1 and 65535/);
  assert.throws(() => buildSshRunArgs({ ...base, port: 1.5 }), /between 1 and 65535/);
});

/**
 * The contract had one implementation, which makes it a shape rather than a
 * contract. These are the promises any backend has to keep, asserted against
 * every backend there is.
 */
test("every runner backend keeps the contract's promises", () => {
  const backends = [
    { runner: createDockerRunner(), argv: () => buildDockerRunArgs({ ...base, workspacePath: "/srv/repo" }) },
    { runner: createSshRunner(), argv: () => buildSshRunArgs(base) },
  ];

  for (const { runner, argv } of backends) {
    // A stable name: it goes into RunnerResult and therefore into what a user
    // reads when asking which environment produced a session.
    assert.equal(typeof runner.name, "string");
    assert.ok(runner.name.length > 0);
    assert.equal(typeof runner.run, "function");

    const rendered = argv().join(" ");
    // The task is what the caller asked for, and the workspace is the only
    // directory named — the one isolation promise the contract makes.
    assert.ok(rendered.includes(base.task), `${runner.name} must run the task it was given`);
    assert.ok(rendered.includes("/srv/repo"), `${runner.name} must name the workspace`);
    // Headless: a runner that stopped for an interactive prompt would hang.
    assert.ok(rendered.includes("-y"), `${runner.name} must run headless`);
  }
});

test("both backends forward the cost cap, because an unbounded remote run is the expensive kind", () => {
  const docker = buildDockerRunArgs({ ...base, maxCostUsd: 1.25 }).join(" ");
  const ssh = buildSshRunArgs({ ...base, maxCostUsd: 1.25 }).join(" ");
  assert.match(docker, /--max-cost 1\.25/);
  assert.match(ssh, /--max-cost '1\.25'/);
});
