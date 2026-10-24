// The Sages section of bb's plugin settings: choices made with bb's own
// pickers, so they follow the providers, models and specialists set up in bb.
import { useCallback, useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  useRpc,
  useSdk,
  type ExperimentalProviderModelPickerValue as PickerValue,
  type PluginAppBuilder,
} from "@get-bb/plugin-sdk/app";
import type { Preferences, rpcContract } from "./server";
import type { envoyRpcContract, Specialist } from "./envoy-contract";
import { Button } from "@/components/ui/button";

const SELECT =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** bb's default provider and model, to start the picker from. */
async function defaultChoice(
  sdk: ReturnType<typeof useSdk>,
): Promise<PickerValue | null> {
  const options = await sdk.providers.models();
  const model = options.models.find((each) => each.isDefault) ?? options.models[0];
  const providerId =
    model?.routeProviderId ??
    options.providers.find((each) => each.available)?.id;
  if (!model || !providerId) return null;
  return {
    providerId,
    model: model.model,
    reasoningLevel: model.defaultReasoningEffort,
  } as PickerValue;
}

function SagesSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const envoyRpc = useRpc<typeof envoyRpcContract>();
  const sdk = useSdk();
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [fallback, setFallback] = useState<PickerValue | null>(null);
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    rpc.call("sages_preferences").then(setPreferences, report);
    envoyRpc
      .call("envoys_specialists")
      .then((result) => setSpecialists(result.specialists), report);
    defaultChoice(sdk).then(setFallback, () => {});
  }, [rpc, envoyRpc, sdk, report]);

  const save = (patch: Partial<Preferences>) =>
    rpc.call("sages_set_preferences", patch).then((next) => {
      setPreferences(next);
      setError(null);
    }, report);

  if (preferences === null)
    return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
  const summaryModel = (preferences.summaryModel as PickerValue | null) ?? fallback;
  const handoff = preferences.readyHandoffSpecialist;
  return (
    <div className="flex flex-col gap-5">
      <div className="space-y-2">
        <p className="text-sm font-medium">Summary model</p>
        <p className="text-xs text-muted-foreground">
          Writes each sage's memory and an acolyte's closing summary. A cheap,
          fast model is enough.{" "}
          {preferences.summaryModel === null
            ? "Using each sage's own model until you pick one."
            : ""}
        </p>
        <div className="flex items-center gap-2">
          {summaryModel ? (
            <ProviderModelPicker
              value={summaryModel}
              onChange={(value) => void save({ summaryModel: value })}
            />
          ) : (
            <span className="text-sm text-muted-foreground">Each sage's model</span>
          )}
          {preferences.summaryModel !== null ? (
            <Button
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => void save({ summaryModel: null })}
            >
              Use each sage's model
            </Button>
          ) : null}
        </div>
      </div>
      <label className="space-y-2 text-sm">
        <span className="font-medium">Ready-PR handoff specialist</span>
        <p className="text-xs text-muted-foreground">
          An Envoy hands its PR to this specialist once the PR is marked ready
          for review; a watcher automation it owns tells it when. With none,
          attached PRs get no watcher.
        </p>
        <select
          className={SELECT}
          value={handoff}
          onChange={(e) => void save({ readyHandoffSpecialist: e.target.value })}
        >
          <option value="">None</option>
          {(specialists ?? []).map((each) => (
            <option key={each.name} value={each.name}>
              {each.name}
            </option>
          ))}
          {handoff && !specialists?.some((each) => each.name === handoff) ? (
            <option value={handoff}>{handoff} (unavailable)</option>
          ) : null}
        </select>
      </label>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

export function registerSettingsApp(app: PluginAppBuilder) {
  app.slots.settingsSection({
    id: "choices",
    title: "Models and handoff",
    description: "Picked from the providers and specialists set up in bb.",
    component: SagesSettings,
  });
}
