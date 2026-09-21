"use client";

import { useEffect, useState } from "react";

import { StatusBadge } from "@intenttrace/ui";

type ApiState =
  | { status: "checking" }
  | { status: "ready"; version: string }
  | { status: "degraded"; reason: string };

export function HealthPanel() {
  const [state, setState] = useState<ApiState>({ status: "checking" });

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/status", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as {
          ready?: boolean;
          version?: string;
          reason?: string;
        };
        if (response.ok && payload.ready) {
          setState({ status: "ready", version: payload.version ?? "unknown" });
        } else {
          setState({ status: "degraded", reason: payload.reason ?? "API is not ready" });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: "degraded",
            reason: error instanceof Error ? error.message : "API unavailable",
          });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.status === "checking") return <StatusBadge tone="neutral">检查 API…</StatusBadge>;
  if (state.status === "ready")
    return <StatusBadge tone="ok">local_mvp · API {state.version}</StatusBadge>;
  return <StatusBadge tone="warning">Raw API 尚未就绪：{state.reason}</StatusBadge>;
}
