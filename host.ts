import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { envoyHostContract } from "./envoy-contract.ts";

const exec = promisify(execFile);
const response = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string(),
});
export default experimental_defineHostEntry({
  contract: envoyHostContract,
  handlers: {
    async prState({ owner, repo, number }, { signal }) {
      let command = "gh";
      for (const path of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
        try {
          await access(path);
          command = path;
          break;
        } catch {
          /* Use PATH if absent. */
        }
      }
      const { stdout } = await exec(
        command,
        [
          "pr",
          "view",
          String(number),
          "--repo",
          `https://github.com/${owner}/${repo}`,
          "--json",
          "state,isDraft,headRefOid",
        ],
        {
          signal,
          timeout: 20_000,
          maxBuffer: 64 * 1024,
          env: { ...process.env, GH_PROMPT_DISABLED: "1" },
        },
      );
      const pr = response.parse(JSON.parse(stdout));
      const state: "draft" | "ready" | "closed" | "merged" =
        pr.state === "OPEN"
          ? pr.isDraft
            ? "draft"
            : "ready"
          : pr.state === "MERGED"
            ? "merged"
            : "closed";
      return { state, head: pr.headRefOid };
    },
  },
});
