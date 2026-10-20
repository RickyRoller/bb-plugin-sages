// Direct, tool-less calls to the CLI behind a bb provider, for summaries.
// bb gives a plugin no plain model call, and a full agent thread per summary
// is slow, so the providers whose CLI has a print mode are called directly.
// Each keeps the user's own CLI config (sign-in, gateways, custom providers);
// any other provider returns null and runs in a bb thread instead.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export type ModelChoice = {
  providerId: string;
  model: string;
  reasoningLevel: string;
};

type Call = {
  command: string;
  args: string[];
  stdin: string;
  /** Where the CLI writes its answer, when not to stdout. */
  outputFile?: string;
};

/** The CLI call for a provider, or null when it has no direct call. */
export function directCall(
  choice: ModelChoice,
  system: string,
  prompt: string,
  dir: string,
): Call | null {
  const { model, reasoningLevel: level } = choice;
  switch (choice.providerId) {
    case "claude-code":
      return {
        command: "claude",
        args: [
          "-p",
          ...["--model", model],
          ...(["low", "medium", "high", "xhigh", "max"].includes(level)
            ? ["--effort", level]
            : []),
          ...["--system-prompt", system],
          ...["--tools", ""],
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--no-session-persistence",
        ],
        stdin: prompt,
      };
    case "codex": {
      const outputFile = join(dir, "answer.txt");
      return {
        command: "codex",
        args: [
          "exec",
          ...["-m", model],
          ...(level === "none"
            ? []
            : ["-c", `model_reasoning_effort=${JSON.stringify(level)}`]),
          ...["--sandbox", "read-only"],
          "--ephemeral",
          "--skip-git-repo-check",
          ...["-o", outputFile],
          "-",
        ],
        // codex exec has no system prompt flag.
        stdin: `${system}\n\n${prompt}`,
        outputFile,
      };
    }
    case "pi":
      return {
        command: "pi",
        args: [
          "-p",
          ...["--model", `${model}:${level === "none" ? "off" : level}`],
          ...["--system-prompt", system],
          "--no-tools",
          "--no-session",
        ],
        stdin: prompt,
      };
    default:
      return null;
  }
}

let shellPath: Promise<string> | null = null;
/**
 * The PATH of the user's interactive shell: CLIs and the runtimes they need
 * (node, bun) are often set up only in its rc file.
 */
export function userPath(): Promise<string> {
  shellPath ??= promisify(execFile)(
    process.env.SHELL ?? "/bin/sh",
    ["-ilc", 'printf "\\n%s" "$PATH"'],
    { timeout: 30_000 },
  ).then(
    ({ stdout }) => stdout.split("\n").pop() || (process.env.PATH ?? ""),
    () => process.env.PATH ?? "",
  );
  return shellPath;
}

/** Thrown when the provider's CLI is not installed. */
export class MissingCli extends Error {}

/**
 * Runs the provider's CLI once and returns its answer, or null when the
 * provider has no direct call.
 */
export async function runDirect(
  choice: ModelChoice,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "sages-summary-"));
  try {
    const call = directCall(choice, system, prompt, dir);
    if (call === null) return null;
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: await userPath() };
    // bb's own variables would make the CLI think it runs inside a bb thread.
    for (const key of Object.keys(env))
      if (key.startsWith("BB_")) delete env[key];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(call.command, call.args, {
        cwd: dir,
        env,
        signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "ENOENT"
            ? new MissingCli(`${call.command} is not installed`)
            : error,
        ),
      );
      child.on("close", (code) => {
        if (code === 0) resolve(out);
        else
          reject(
            new Error(
              `${call.command} exited with ${code}: ${(err || out).trim().slice(-300)}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(call.stdin);
    });
    return call.outputFile ? await readFile(call.outputFile, "utf8") : stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
