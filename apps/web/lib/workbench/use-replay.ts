"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useWorkbenchStore } from "./store";

const TICK_MS = 700;
/** Advance a share of the trace per tick so long traces still replay quickly. */
const STEPS_PER_TICK = 24;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export interface ReplayControls {
  playing: boolean;
  canReplay: boolean;
  toggle: () => void;
  restart: () => void;
}

/**
 * Replay advances the ingest watermark (never source time), so the graph,
 * Gantt, raw table and evidence all move through the same cursor the
 * interaction spec defines. Reduced-motion users get a single jump to the end.
 */
export function useReplay(): ReplayControls {
  const store = useWorkbenchStore;
  const latest = useWorkbenchStore((state) => Number(state.snapshot?.trace.latestIngestSeq ?? 0));
  const [playing, setPlaying] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    if (!playing) return;
    const step = Math.max(1, Math.ceil(latest / STEPS_PER_TICK));
    timerRef.current = setInterval(() => {
      const state = store.getState();
      const next = state.playhead + step;
      if (next >= latest) {
        state.setPlayhead(latest);
        setPlaying(false);
        return;
      }
      state.setPlayhead(next);
    }, TICK_MS);
    return () => clearInterval(timerRef.current);
  }, [latest, playing, store]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const toggle = useCallback(() => {
    if (latest <= 0) return;
    if (playing) {
      setPlaying(false);
      return;
    }
    if (prefersReducedMotion()) {
      store.getState().setPlayhead(latest);
      return;
    }
    if (store.getState().playhead >= latest) store.getState().setPlayhead(0);
    setPlaying(true);
  }, [latest, playing, store]);

  const restart = useCallback(() => {
    setPlaying(false);
    store.getState().setPlayhead(0);
  }, [store]);

  return { playing, canReplay: latest > 0, toggle, restart };
}
