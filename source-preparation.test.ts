import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { prepareSource } from "./source-preparation.ts";

const exec = promisify(execFile);

test("real Git preparation fetches before running the install command, preserves local work, and releases its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "envoy-source-"));
  const upstream = join(root, "upstream");
  const base = join(root, "base");
  const git = async (cwd: string, ...args: string[]) =>
    (await exec("git", args, { cwd })).stdout.trim();
  const commit = async (file: string, text: string, message: string) => {
    await writeFile(join(upstream, file), text);
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-m", message);
    return git(upstream, "rev-parse", "HEAD");
  };
  // Records the commit it ran at, like an install that writes ignored files.
  const install = "git rev-parse HEAD > installed-head";
  const installed = async () =>
    (await readFile(join(base, "installed-head"), "utf8")).trim();
  try {
    await mkdir(upstream);
    await git(upstream, "init", "-b", "main");
    await git(upstream, "config", "user.email", "test@example.com");
    await git(upstream, "config", "user.name", "Test");
    await commit(".gitignore", "installed-head\n", "chore: fixture");
    await git(root, "clone", upstream, base);
    const latest = await commit("change.txt", "latest\n", "fix: latest change");
    assert.notEqual(await git(base, "rev-parse", "HEAD"), latest);
    assert.equal((await prepareSource(base, install)).commit, latest);
    assert.equal(await installed(), latest);
    assert.equal(await git(base, "status", "--porcelain"), "");
    await writeFile(join(base, "change.txt"), "user edits\n");
    await assert.rejects(prepareSource(base, install), /local changes/);
    assert.equal(await readFile(join(base, "change.txt"), "utf8"), "user edits\n");
    await writeFile(join(base, "change.txt"), "latest\n");
    await git(base, "config", "user.email", "test@example.com");
    await git(base, "config", "user.name", "Test");
    await git(base, "commit", "--allow-empty", "-m", "chore: local work");
    const local = await git(base, "rev-parse", "HEAD");
    await assert.rejects(prepareSource(base, install), /local or divergent commits/);
    assert.equal(await git(base, "rev-parse", "HEAD"), local);
    await git(base, "push", "origin", "HEAD:refs/heads/test-local");
    await git(upstream, "merge", "--ff-only", "test-local");
    // A failed install must be retriable, and the lock released.
    await assert.rejects(prepareSource(base, "exit 7"), /code 7|exit 7|failed/i);
    assert.equal((await prepareSource(base, install)).commit, local);
    // An empty install command only fast-forwards.
    const head = await commit("skipped.txt", "skipped\n", "chore: no install");
    assert.equal((await prepareSource(base, "")).commit, head);
    assert.notEqual(await installed(), head);
  } finally { await rm(root, { recursive: true, force: true }); }
});
