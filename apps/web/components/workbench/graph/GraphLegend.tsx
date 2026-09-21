// Edge swatches cover the structural relations the reducer derives and the
// workbench can therefore actually render.
const swatches: Array<{ color: string; label: string }> = [
  { color: "bg-accent", label: "Intent/work" },
  { color: "bg-red", label: "Issue" },
  { color: "bg-green", label: "Result" },
  { color: "bg-muted-2", label: "Spawn edge (decomposes_to)" },
  { color: "bg-pink", label: "Handoff edge (hands_off_to)" },
  { color: "bg-red", label: "Blocks edge" },
];

export function GraphLegend() {
  return (
    <div className="flex items-center gap-3 rounded-[9px] border border-line bg-panel/88 px-2.5 py-1.5 backdrop-blur">
      {swatches.map((swatch) => (
        <span key={swatch.label} className="flex items-center gap-1.5 text-micro text-muted">
          <span aria-hidden className={`size-2 rounded-sm ${swatch.color}`} />
          {swatch.label}
        </span>
      ))}
    </div>
  );
}
