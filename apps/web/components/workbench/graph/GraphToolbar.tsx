"use client";

import { useReactFlow } from "@xyflow/react";
import { useState } from "react";

import { useWorkbenchStore } from "@/lib/workbench/store";

function Chip({
  active,
  onClick,
  children,
  pressedLabel,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
  pressedLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={pressedLabel ?? children}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-micro backdrop-blur ${
        active
          ? "border-accent/35 bg-accent/12 text-ink"
          : "border-line bg-panel/88 text-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function GraphToolbar() {
  const filters = useWorkbenchStore((state) => state.filters);
  const setFilters = useWorkbenchStore((state) => state.setFilters);
  const { zoomTo, fitView } = useReactFlow();
  const [zoomPreset, setZoomPreset] = useState<"l1" | "l2" | "fit" | null>(null);

  const intentTreeActive = !filters.failuresOnly && !filters.dimSemantic;

  return (
    <div className="flex w-full items-start justify-between gap-2">
      <div className="flex gap-1.5" role="group" aria-label="View filters">
        <Chip
          active={intentTreeActive}
          onClick={() => setFilters({ failuresOnly: false, dimSemantic: false })}
        >
          Intent tree
        </Chip>
        <Chip
          active={filters.dimSemantic}
          onClick={() => setFilters({ dimSemantic: !filters.dimSemantic, failuresOnly: false })}
          pressedLabel="Raw spans emphasis"
        >
          Raw spans
        </Chip>
        <Chip
          active={filters.failuresOnly}
          onClick={() => setFilters({ failuresOnly: !filters.failuresOnly, dimSemantic: false })}
        >
          Failures only
        </Chip>
      </div>
      <div className="flex gap-1.5" role="group" aria-label="Zoom level">
        <Chip
          active={zoomPreset === "l1"}
          onClick={() => {
            setZoomPreset("l1");
            void zoomTo(0.55, { duration: 200 });
          }}
        >
          L1
        </Chip>
        <Chip
          active={zoomPreset === "l2"}
          onClick={() => {
            setZoomPreset("l2");
            void zoomTo(1, { duration: 200 });
          }}
        >
          L2
        </Chip>
        <Chip
          active={zoomPreset === "fit"}
          onClick={() => {
            setZoomPreset("fit");
            void fitView({ duration: 200 });
          }}
        >
          Fit
        </Chip>
      </div>
    </div>
  );
}
