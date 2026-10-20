import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const lifecycleSchema = z.enum([
  "creating",
  "active",
  "parked",
  "completed",
  "cancelled",
]);
export const issueSchema = z.object({ key: z.string(), url: z.string() });
/** An issue link on any tracker; `hosts`, when given, restricts its hostname. */
export function issueLink(raw: string, hosts: string[] = []) {
  if (!raw.trim()) return null;
  const url = new URL(raw.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    (hosts.length > 0 && !hosts.includes(url.hostname))
  )
    throw new Error(
      hosts.length > 0
        ? `Use a full https:// issue URL on ${hosts.join(", ")}`
        : "Use a full https:// issue URL",
    );
  url.search = "";
  url.hash = "";
  // A tracker key (ABC-123) when the path has one, else a trailing number.
  const number = /\/(\d+)\/?$/u.exec(url.pathname)?.[1];
  const key =
    /\b[A-Z][A-Z0-9]*-\d+\b/u.exec(url.pathname)?.[0] ??
    (number ? `#${number}` : url.hostname);
  return { key, url: url.toString() };
}
export function githubPr(raw: string) {
  const url = new URL(raw.trim());
  const match = /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/u.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    !match
  )
    throw new Error("Use a full https://github.com/owner/repo/pull/123 URL");
  if (!Number.isSafeInteger(Number(match[3])))
    throw new Error("Invalid PR number");
  return {
    owner: match[1]!.toLowerCase(),
    repo: match[2]!.toLowerCase(),
    number: Number(match[3]),
    url: `https://github.com/${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}/pull/${Number(match[3])}`,
  };
}
export function taskName(directive: string): string {
  const first =
    directive
      .trim()
      .split(/\n/u)
      .find(Boolean)
      ?.replace(/^#+\s*/u, "")
      .replace(/\s+/gu, " ") ?? "New task";
  return first.length <= 80 ? first : `${first.slice(0, 77).trimEnd()}…`;
}
export const prSchema = z.object({
  url: z.string(),
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
});
export const envoySchema = z.object({
  id: z.string(),
  requestId: z.string(),
  name: z.string(),
  nameSource: z.enum(["explicit", "generated"]),
  directive: z.string(),
  projectId: z.string(),
  threadId: z.string().nullable(),
  environmentId: z.string().nullable(),
  lifecycle: lifecycleSchema,
  creation: z.enum(["reserved", "launching", "ready", "failed", "uncertain"]),
  error: z.string().nullable(),
  issue: issueSchema.nullable(),
  specialist: z.string().nullable(),
  /** The sage that started it, which hears how each of its turns ends. */
  reportTo: z
    .object({ sageId: z.string(), name: z.string() })
    .nullable()
    .default(null),
  prs: z.array(prSchema),
  result: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Envoy = z.infer<typeof envoySchema>;
export type EnvoyPr = z.infer<typeof prSchema>;
export const specialistSchema = z.object({
  name: z.string(),
  description: z.string(),
  prompt: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).nullable(),
});
export type Specialist = z.infer<typeof specialistSchema>;
// BB validates the complete composer request at spawn. Only accepted execution
// fields are forwarded; callers cannot inject origin, parentage or visibility.
export const requestSchema = z.object({
  projectId: z.string().min(1),
  input: z
    .array(z.looseObject({ type: z.string() }))
    .min(1)
    .max(100),
  environment: z.record(z.string(), z.unknown()),
  providerId: z.string().optional(),
  model: z.string().optional(),
  reasoningLevel: z
    .enum([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "none",
      "ultra",
      "ultracode",
    ])
    .optional(),
  permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
  serviceTier: z.string().optional(),
  sendAt: z.number().int().nonnegative().optional(),
  executionInputSources: z
    .object({
      providerId: z.enum(["explicit", "client-preference"]).optional(),
      model: z.enum(["explicit", "client-preference"]).optional(),
      reasoningLevel: z.enum(["explicit", "client-preference"]).optional(),
      permissionMode: z.enum(["explicit", "client-preference"]).optional(),
      serviceTier: z.enum(["explicit", "client-preference"]).optional(),
    })
    .strict()
    .optional(),
});
export const createSchema = z.object({
  requestId: z.string().min(1).max(100),
  name: z.string().trim().max(80).default(""),
  issueUrl: z.string().trim().max(2000).default(""),
  specialist: z.string().nullable().default(null),
  reportTo: envoySchema.shape.reportTo,
  request: requestSchema,
});
export const envoyRpcContract = defineRpcContract({
  envoys_list: {
    input: z.null(),
    output: z.object({ envoys: z.array(envoySchema) }),
  },
  envoys_get: {
    input: z.object({ threadId: z.string() }),
    output: envoySchema.nullable(),
  },
  envoys_create: { input: createSchema, output: envoySchema },
  envoys_retry: { input: z.object({ id: z.string() }), output: envoySchema },
  envoys_update: {
    input: z.object({
      id: z.string(),
      name: z.string().trim().min(1).max(80).optional(),
      issueUrl: z.string().max(2000).optional(),
    }),
    output: envoySchema,
  },
  envoys_lifecycle: {
    input: z.object({
      id: z.string(),
      lifecycle: z.enum(["active", "parked", "completed", "cancelled"]),
    }),
    output: envoySchema,
  },
  envoys_pr: {
    input: z.object({
      id: z.string(),
      url: z.string().max(2000),
      action: z.enum(["attach", "detach"]),
    }),
    output: envoySchema,
  },
  envoys_specialists: {
    input: z.null(),
    output: z.object({
      specialists: z.array(specialistSchema),
      available: z.boolean(),
    }),
  },
  envoys_summaries: {
    input: z.object({ threadIds: z.array(z.string()).max(1000) }),
    output: z.object({
      envoys: z.array(
        envoySchema.pick({
          id: true,
          threadId: true,
          lifecycle: true,
          issue: true,
        }),
      ),
    }),
  },
});
export const envoyHostContract = defineRpcContract({
  prepareSource: {
    input: z.object({ path: z.string().min(1), installCommand: z.string() }),
    output: z.object({ commit: z.string().regex(/^[a-f0-9]{40,64}$/u), branch: z.string().min(1) }),
  },
});
