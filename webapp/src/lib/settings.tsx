import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

// Global decider settings. Lives outside the stream-start flow so it applies
// everywhere decide runs. Persisted to localStorage so the choice sticks.
export interface DeciderSettings {
  reasoningEffort: string;
  setReasoningEffort: (v: string) => void;
}

const KEY = "highlights.decider.settings";
const Ctx = createContext<DeciderSettings | null>(null);

function load(): string {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return "none";
    const v = JSON.parse(raw).reasoningEffort;
    return ["none", "low", "medium", "high"].includes(v) ? v : "none";
  } catch {
    return "none";
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [reasoningEffort, setReasoningEffortState] = useState<string>(load);

  function setReasoningEffort(v: string) {
    setReasoningEffortState(v);
    try {
      localStorage.setItem(KEY, JSON.stringify({ reasoningEffort: v }));
    } catch {
      /* private mode etc. */
    }
  }

  const value = useMemo<DeciderSettings>(() => ({ reasoningEffort, setReasoningEffort }), [reasoningEffort]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSettings(): DeciderSettings {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSettings outside <SettingsProvider>");
  return ctx;
}
