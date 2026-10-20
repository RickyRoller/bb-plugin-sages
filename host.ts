import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { envoyHostContract } from "./envoy-contract.ts";
import { userPath } from "./harness.ts";
import { prepareSource } from "./source-preparation.ts";

const exec = promisify(execFile);
const response = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string(),
});
export default experimental_defineHostEntry({
  contract: envoyHostContract,
  handlers: {
    prepareSource: ({ path, installCommand }, { signal }) =>
      prepareSource(path, installCommand, signal),
    async prState({ owner, repo, number }, { signal }) {
      const { stdout } = await exec(
        "gh",
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
          env: { ...process.env, PATH: await userPath(), GH_PROMPT_DISABLED: "1" },
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
