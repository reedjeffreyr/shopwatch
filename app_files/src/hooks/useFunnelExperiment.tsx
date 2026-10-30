import { createElement, useCallback, useRef } from "react";
import { useLocation } from "react-router-dom";

type Inspection = Readonly<{ mounted: boolean; disposed: boolean; ownsNodes: boolean }>;
type Controller = { goal: (key: string) => Promise<boolean>; error: () => Promise<boolean>;
  dispose: () => void; inspect: () => Inspection };
type Runtime = { mount: (root: HTMLElement) => Controller };
type EdgeExperiment = { schema_version: number; experiment_id: number; route_path: string; root_key: string;
  goal_key: string; arm: string; slots: Record<string, string>; holdout: boolean;
  decision_id: string | null; receipt_token: string | null; runtime_fingerprint: string };

// The Worker may decide the arm BEFORE the first byte of HTML
// (:cfai_split_testing) and inject it as window.APP_CONFIG.experiment. Reading
// it synchronously here means the first paint already shows the decided arm —
// no post-paint swap, no flicker. Absent that key (flag off, previews, older
// bundles) everything below behaves exactly as before.
function edgeExperiment(): EdgeExperiment | null {
  const config = (window as Window & { APP_CONFIG?: { experiment?: EdgeExperiment } }).APP_CONFIG;
  const experiment = config && config.experiment;
  if (!experiment || experiment.schema_version !== 2) return null;
  if (!experiment.slots || typeof experiment.slots !== "object") return null;
  if (typeof experiment.route_path !== "string" || window.location.pathname !== experiment.route_path) return null;
  return experiment;
}

async function edgeReceipt(experiment: EdgeExperiment, kind: "goal" | "error", goalKey?: string): Promise<boolean> {
  if (!experiment.receipt_token) return false;
  try {
    const response = await fetch(`${window.location.origin}/_overskill/experiments/receipts`, {
      method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runtime_fingerprint: experiment.runtime_fingerprint,
        token: experiment.receipt_token, kind, ...(goalKey ? { goal_key: goalKey } : {}) })
    });
    if (!response.ok) return false;
    const body = await response.json();
    return !!body && body.accepted === true;
  } catch { return false; }
}

// Platform-owned bridge. Ordinary builds and previews have no runtime and are
// inert. Declare one root and text-only leaf spans; goals are explicit events,
// called after your action succeeds, never automatically from a click.
export function useFunnelExperiment(rootKey: string) {
  const location = useLocation();
  const controller = useRef<Controller | null>(null);
  const dispose = useCallback(() => { controller.current?.dispose(); controller.current = null; }, []);
  const ref = useCallback((root: HTMLElement | null) => {
    dispose();
    // An edge-decided arm is already painted; mounting the imperative
    // controller here would re-decide it after paint.
    const edge = edgeExperiment();
    if (edge && edge.root_key === rootKey) return;
    const runtime = (window as Window & { OverskillExperiments?: Runtime }).OverskillExperiments;
    if (root && runtime) controller.current = runtime.mount(root);
  }, [rootKey, location.pathname, location.search, location.hash, dispose]);
  const goal = useCallback((key: string) => {
    const edge = edgeExperiment();
    if (edge && edge.root_key === rootKey) return key === edge.goal_key ? edgeReceipt(edge, "goal", key) : Promise.resolve(false);
    return controller.current?.goal(key) ?? Promise.resolve(false);
  }, [rootKey]);
  const error = useCallback(() => {
    const edge = edgeExperiment();
    if (edge && edge.root_key === rootKey) return edgeReceipt(edge, "error");
    return controller.current?.error() ?? Promise.resolve(false);
  }, [rootKey]);
  return { rootProps: { ref, "data-os-experiment-root": rootKey }, goal, error, dispose };
}

// Narrow imperative-leaf adapter: React owns the span identity. A React text
// change/replacement invalidates measurement; the controller never forces its
// text back over new props. Keep icons/links outside this leaf, and use this
// hook only within the router so navigation disposes the prior epoch. When the
// edge decided the arm, the decided slot text renders on the FIRST paint.
export function ExperimentText({ slot, children, className }: { slot: string; children: string; className?: string }) {
  const edge = edgeExperiment();
  const text = edge && typeof edge.slots[slot] === "string" ? edge.slots[slot] : children;
  return createElement("span", { "data-os-experiment-slot": slot, className }, text);
}
