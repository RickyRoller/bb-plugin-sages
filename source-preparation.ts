import { execFile } from "node:child_process";
import { mkdir, realpath, rmdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Fast-forward an explicitly opted-in source and run its install command;
 * never reset or stash user work.
 */
export async function prepareSource(
  path: string,
  installCommand: string,
  signal?: AbortSignal,
) {
  const cwd = await realpath(path);
  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !key.startsWith("BB_") && key !== "NODE_ENV",
  ));
  const run = async (command: string, args: string[], timeout = 60_000) =>
    (await exec(command, args, {
      cwd, signal, timeout, maxBuffer: 2 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    })).stdout.trim();
  const git = (...args: string[]) => run("git", args);
  if (await realpath(await git("rev-parse", "--show-toplevel")) !== cwd)
    throw new Error("The source must be a repository root");
  const lock = resolve(cwd, await git("rev-parse", "--git-common-dir"), "envoy-prepare.lock");
  try { await mkdir(lock); }
  catch { throw new Error(`Source preparation is locked: ${lock}. Retry after the current preparation finishes; inspect interrupted runs before removing a stale lock.`); }
  try {
    const clean = async () => {
      if (await git("status", "--porcelain"))
        throw new Error("Source has local changes; commit or move them before creating an Envoy");
    };
    await clean();
    const remote = await git("ls-remote", "--symref", "origin", "HEAD");
    const branch = /^ref: refs\/heads\/(.+)\tHEAD$/mu.exec(remote)?.[1];
    if (!branch) throw new Error("Cannot determine origin's default branch");
    if (await git("symbolic-ref", "--short", "HEAD") !== branch)
      throw new Error(`Source must be on the default branch (${branch})`);
    await git("fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    const commit = await git("rev-parse", `refs/remotes/origin/${branch}^{commit}`);
    try { await git("merge-base", "--is-ancestor", "HEAD", commit); }
    catch { throw new Error("Source has local or divergent commits; refusing to reset them"); }
    await git("merge", "--ff-only", commit);
    // An interactive login shell, so the command sees the PATH and version
    // managers the user's shell sets up (often only in its rc file).
    if (installCommand.trim())
      await run(env.SHELL || "/bin/sh", ["-ilc", installCommand], 15 * 60_000);
    await clean();
    if (await git("rev-parse", "HEAD") !== commit)
      throw new Error("Source HEAD changed during dependency installation; retry preparation");
    return { commit, branch };
  } finally {
    await rmdir(lock);
  }
}
