"use client";

import { useEffect } from "react";

import { useWorkbenchStore } from "./store";

const panelKeys: Record<string, string> = {
  "1": "Intent graph",
  "2": "Agent Gantt",
  "3": "Raw events",
  "4": "Evidence inspector",
};

/**
 * Global workbench shortcuts: 1-4 move focus between the main regions,
 * Escape closes the inspector. Node traversal itself relies on the native
 * tab order of focusable node cards / rows inside each region.
 */
export function useWorkbenchKeyboard() {
  const store = useWorkbenchStore;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const label = panelKeys[event.key];
      if (label) {
        const region = document.querySelector<HTMLElement>(`[aria-label="${label}"]`);
        if (region) {
          event.preventDefault();
          if (label === "Evidence inspector") store.getState().setInspectorOpen(true);
          region.tabIndex = -1;
          region.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        store.getState().setInspectorOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);
}
