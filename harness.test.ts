import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { directCall, MissingCli, runDirect } from "./harness.ts";

test("each provider with a print mode maps to a tool-less CLI call", () => {
  const claude = directCall(
    { providerId: "claude-code", model: "m", reasoningLevel: "ultracode" },
    "SYS",
    "PROMPT",
    "/tmp/x",
  )!;
  assert.equal(claude.command, "claude");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--tools"), claude.args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(!claude.args.includes("--effort"), "levels claude lacks are left out");
  assert.equal(claude.stdin, "PROMPT");

  const codex = directCall(
    { providerId: "codex", model: "m", reasoningLevel: "low" },
    "SYS",
    "PROMPT",
    "/tmp/x",
  )!;
  assert.equal(codex.command, "codex");
  assert.ok(codex.args.includes('model_reasoning_effort="low"'));
  assert.equal(codex.stdin, "SYS\n\nPROMPT");
  assert.equal(codex.outputFile, "/tmp/x/answer.txt");

  const pi = directCall(
    { providerId: "pi", model: "or/m", reasoningLevel: "none" },
    "SYS",
    "PROMPT",
    "/tmp/x",
  )!;
  assert.ok(pi.args.includes("or/m:off"));
  assert.ok(pi.args.includes("--no-tools"));

  assert.equal(
    directCall({ providerId: "acp-cursor", model: "m", reasoningLevel: "low" }, "S", "P", "/tmp/x"),
    null,
  );
});

test("a direct call finds the CLI on the user's shell PATH and reads its answer", async () => {
  const bin = await mkdtemp(join(tmpdir(), "sages-harness-"));
  const shell = process.env.SHELL;
  try {
    // A fake shell whose PATH holds only the fake CLI and the system tools.
    await writeFile(join(bin, "shell"), `#!/bin/sh\nprintf '\\n%s' "${bin}:/usr/bin:/bin"\n`);
    // A fake claude that echoes its system prompt and stdin.
    await writeFile(
      join(bin, "claude"),
      `#!/bin/sh\nwhile [ "$1" != "--system-prompt" ]; do shift; done\nprintf '%s|' "$2"; cat\n`,
    );
    await chmod(join(bin, "shell"), 0o755);
    await chmod(join(bin, "claude"), 0o755);
    process.env.SHELL = join(bin, "shell");
    const signal = AbortSignal.timeout(10_000);
    assert.equal(
      await runDirect({ providerId: "claude-code", model: "m", reasoningLevel: "low" }, "SYS", "hello", signal),
      "SYS|hello",
    );
    await assert.rejects(
      runDirect({ providerId: "pi", model: "m", reasoningLevel: "low" }, "S", "P", signal),
      MissingCli,
    );
    assert.equal(
      await runDirect({ providerId: "acp-cursor", model: "m", reasoningLevel: "low" }, "S", "P", signal),
      null,
    );
  } finally {
    process.env.SHELL = shell;
    await rm(bin, { recursive: true, force: true });
  }
});
