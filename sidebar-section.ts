// The Sages and Envoys sections of the Sidebar Thread Details plugin, and the
// hook other plugins use to put badges on Envoy rows.
//
// Sidebar Thread Details finds section providers by the discoverable method
// `sidebar-section.v1.get` and draws what they return, so this plugin decides
// what its sections hold. Envoy badges start with the issue link; any plugin
// that publishes a discoverable `envoy-decorations.v1.get` adds its own (the
// Metro Control plugin shows each Envoy's Metro and validation devices). The
// user hides a source in the Sages settings.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { lifecycleSchema, type Envoy } from "./envoy-contract.ts";

export const DECORATION_METHOD = "envoy-decorations.v1.get";
/** The built-in badge source, beside the plugin ids of decorators. */
export const ISSUE_SOURCE = "issue";
const DECORATOR_TIMEOUT_MS = 3_000;
/** Envoys re-sort for activity at most this often, so rows do not jump. */
export const ACTIVITY_THROTTLE_MS = 30_000;

export const badgeSchema = z.object({
  label: z.string().min(1).max(40),
  tone: z
    .enum(["neutral", "info", "success", "warning", "danger"])
    .default("neutral"),
  /** "title" sits beside the row's title; "meta" on the line below it. */
  placement: z.enum(["title", "meta"]).default("meta"),
  href: z.url({ protocol: /^https$/ }).nullable().default(null),
  /** Tooltip text. */
  title: z.string().max(500).nullable().default(null),
});
export type Badge = z.infer<typeof badgeSchema>;

const linkBase = {
  id: z.string(),
  label: z.string(),
  path: z.string(),
  icon: z.string().nullable(),
};

export const sidebarSectionContract = defineRpcContract({
  "sidebar-section.v1.get": {
    experimental_description:
      "Sections for the Sidebar Thread Details sidebar: links, and the given threads this plugin claims with their badges.",
    input: z.object({ threadIds: z.array(z.string()).max(1000) }),
    output: z.object({
      sections: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          order: z.number(),
          reorderable: z.boolean(),
          links: z.array(
            z.object({ ...linkBase, children: z.array(z.object(linkBase)) }),
          ),
          threads: z.array(
            z.object({
              threadId: z.string(),
              badges: z.array(badgeSchema),
              activityAt: z.number().nullable(),
            }),
          ),
        }),
      ),
    }),
  },
  "sidebar-section.v1.reorder": {
    experimental_description: "Puts a section's links in this order.",
    input: z.object({
      sectionId: z.string(),
      ids: z.array(z.string()).max(1000),
    }),
    output: z.object({ ids: z.array(z.string()) }),
  },
});

/** What a decorator is told about each Envoy; it looks up anything else. */
export const decorationInputSchema = z.object({
  envoys: z
    .array(
      z.object({
        id: z.string(),
        threadId: z.string().nullable(),
        projectId: z.string(),
        environmentId: z.string().nullable(),
        lifecycle: lifecycleSchema,
      }),
    )
    .max(1000),
});
const decorationOutputSchema = z.object({
  decorations: z.array(z.unknown()),
});
const decorationSchema = z.object({
  envoyId: z.string(),
  badges: z.array(badgeSchema).max(4),
});

export const badgeRpcContract = defineRpcContract({
  /** A decorator's badges changed: every open sidebar asks again. */
  envoys_badges_changed: {
    input: z.object({}).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  /** Every badge source the user can hide in the settings. */
  envoys_badge_sources: {
    input: z.null(),
    output: z.object({
      sources: z.array(z.object({ id: z.string(), label: z.string() })),
    }),
  },
});

type ListedSage = { id: string; name: string; parentId: string | null; archivedAt?: string | null };

export function registerSidebarSection(
  bb: BbPluginApi,
  deps: {
    sages: () => readonly ListedSage[];
    reorderSages: (ids: string[]) => Promise<string[]>;
    envoys: () => Iterable<Envoy>;
    hiddenBadges: () => readonly string[];
    activityThrottleMs?: number;
  },
) {
  // --- Envoy activity ---
  // The sidebar sorts Envoys by their latest activity, counting their child
  // threads. A thread's own timestamps lag a running turn, so each turn that
  // starts or ends in an Envoy or under it is noted here. Notes are published
  // together, at most once per ACTIVITY_THROTTLE_MS: the first at once, later
  // ones at the end of the window. Sections served in between show only
  // published activity, so no other refresh re-sorts early.
  const throttleMs = deps.activityThrottleMs ?? ACTIVITY_THROTTLE_MS;
  const activity = new Map<string, number>();
  const pending = new Map<string, number>();
  let flushTimer: NodeJS.Timeout | null = null;
  let lastFlush = -Infinity;
  const flush = () => {
    flushTimer = null;
    lastFlush = Date.now();
    for (const [envoyId, at] of pending) activity.set(envoyId, at);
    pending.clear();
    nudgeSidebar(bb);
  };
  /** Thread id → the Envoy it works under, or null; resolved once. */
  const owners = new Map<string, string | null>();
  async function ownerOf(
    threadId: string,
    parentThreadId?: string | null,
    depth = 0,
  ): Promise<string | null> {
    const direct = [...deps.envoys()].find((e) => e.threadId === threadId);
    if (direct) return direct.id;
    if (owners.has(threadId)) return owners.get(threadId)!;
    if (depth > 20) return null;
    const parent =
      parentThreadId !== undefined
        ? parentThreadId
        : await bb.sdk.threads
            .get({ threadId })
            .then((thread) => thread.parentThreadId, () => undefined);
    // An unreadable thread is asked again next time rather than cached.
    if (parent === undefined) return null;
    const owner = parent ? await ownerOf(parent, undefined, depth + 1) : null;
    if (owners.size > 5_000) owners.clear();
    owners.set(threadId, owner);
    return owner;
  }
  const noteActivity = async (thread: {
    id: string;
    parentThreadId: string | null;
  }) => {
    const envoyId = await ownerOf(thread.id, thread.parentThreadId).catch(
      () => null,
    );
    if (!envoyId) return;
    pending.set(envoyId, Date.now());
    flushTimer ??= setTimeout(
      flush,
      Math.max(0, lastFlush + throttleMs - Date.now()),
    ).unref();
  };
  for (const event of ["thread.active", "thread.idle", "thread.failed"] as const)
    bb.events.on(event, ({ thread }) => void noteActivity(thread));

  async function decorators() {
    const methods = await bb.sdk.plugins
      .experimental_discoverRpc({ method: DECORATION_METHOD })
      .catch(() => []);
    return [
      ...new Map(methods.map((each) => [each.pluginId, each.displayName])),
    ].map(([id, label]) => ({ id, label }));
  }

  /**
   * Each decorator's badges by Envoy id, in discovery order. A decorator that
   * fails, answers late or returns a malformed row adds nothing.
   */
  async function decorate(envoys: Envoy[]) {
    const hidden = new Set(deps.hiddenBadges());
    const sources = (await decorators()).filter(({ id }) => !hidden.has(id));
    const byEnvoy = new Map<string, Badge[]>();
    if (!envoys.length) return byEnvoy;
    const input = {
      envoys: envoys.map(
        ({ id, threadId, projectId, environmentId, lifecycle }) => ({
          id,
          threadId,
          projectId,
          environmentId,
          lifecycle,
        }),
      ),
    };
    const answers = await Promise.all(
      sources.map(({ id: pluginId }) =>
        bb.sdk.plugins
          .callRpc({
            pluginId,
            method: DECORATION_METHOD,
            input,
            outputSchema: decorationOutputSchema,
            signal: AbortSignal.timeout(DECORATOR_TIMEOUT_MS),
          })
          .then(
            (result) => result.decorations,
            (error) => {
              bb.log.warn(`Envoy badges from ${pluginId} failed: ${error}`);
              return [];
            },
          ),
      ),
    );
    for (const decorations of answers)
      for (const raw of decorations) {
        const parsed = decorationSchema.safeParse(raw);
        if (!parsed.success) continue;
        const list = byEnvoy.get(parsed.data.envoyId) ?? [];
        list.push(...parsed.data.badges);
        byEnvoy.set(parsed.data.envoyId, list);
      }
    return byEnvoy;
  }

  bb.rpc.register(
    sidebarSectionContract,
    {
      "sidebar-section.v1.get": async ({ threadIds }) => {
        const ids = new Set(threadIds);
        const envoys = [...deps.envoys()].filter(
          (each) => each.threadId && ids.has(each.threadId),
        );
        const showIssue = !deps.hiddenBadges().includes(ISSUE_SOURCE);
        const extra = await decorate(envoys);
        const sages = deps.sages();
        const link = (sage: ListedSage, icon: string) => ({
          id: sage.id,
          label: sage.name,
          path: `/plugins/sages/sages/${sage.id}`,
          icon,
        });
        return {
          sections: [
            {
              id: "sages",
              title: "Sages",
              order: 0,
              reorderable: true,
              threads: [],
              links: sages
                .filter((sage) => sage.parentId == null)
                .map((sage) => ({
                  ...link(sage, "sages/sage"),
                  children: sages
                    .filter(
                      (acolyte) =>
                        acolyte.parentId === sage.id &&
                        acolyte.archivedAt == null,
                    )
                    .map((acolyte) => link(acolyte, "GitBranch")),
                })),
            },
            {
              id: "envoys",
              title: "Envoys",
              order: 1,
              reorderable: false,
              links: [],
              threads: envoys.map((envoy) => ({
                threadId: envoy.threadId!,
                activityAt: activity.get(envoy.id) ?? null,
                badges: [
                  ...(showIssue && envoy.issue
                    ? [
                        badgeSchema.parse({
                          label: `[${envoy.issue.key}]`.slice(0, 40),
                          href: envoy.issue.url,
                          title: envoy.issue.url,
                        }),
                      ]
                    : []),
                  ...(extra.get(envoy.id) ?? []),
                ],
              })),
            },
          ],
        };
      },
      "sidebar-section.v1.reorder": async ({ sectionId, ids }) => {
        if (sectionId !== "sages") throw new Error("Only sages can be reordered");
        return { ids: await deps.reorderSages(ids) };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "The Sages and Envoys sections of the Sidebar Thread Details sidebar.",
    },
  );

  bb.rpc.register(badgeRpcContract, {
    envoys_badges_changed: () => {
      nudgeSidebar(bb);
      return { ok: true as const };
    },
    envoys_badge_sources: async () => ({
      sources: [
        { id: ISSUE_SOURCE, label: "Issue link" },
        ...(await decorators()),
      ],
    }),
  });
}

const NUDGE_MS = 300;
const nudges = new WeakMap<BbPluginApi, NodeJS.Timeout>();
/**
 * Tells open sidebars to ask this plugin for its sections again; changes
 * within NUDGE_MS go out as one. Without the sidebar plugin, a no-op.
 */
export function nudgeSidebar(bb: BbPluginApi): void {
  if (nudges.has(bb)) return;
  nudges.set(
    bb,
    setTimeout(() => {
      nudges.delete(bb);
      try {
        void bb.sdk.plugins
          .callRpc({
            pluginId: "sidebar-thread-details",
            method: "refreshSections",
            input: {},
            outputSchema: z.unknown(),
          })
          .catch(() => {});
      } catch {
        // Reloaded or disabled since: the new instance nudges for itself.
      }
    }, NUDGE_MS).unref(),
  );
}
