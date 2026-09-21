"use client";

import { useEffect, useRef, useState } from "react";

import { Button } from "./index.js";

type CopyState = "idle" | "copied" | "failed";

const stateLabels: Record<CopyState, string | null> = {
  idle: null,
  copied: "Copied",
  failed: "Copy failed",
};

/** Clipboard write with a transient result label; clipboard APIs reject outside secure contexts. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    timer.current = setTimeout(() => setState("idle"), 1500);
  };

  return (
    <Button variant="ghost" onClick={() => void copy()} aria-live="polite">
      {stateLabels[state] ?? label}
    </Button>
  );
}
