import type { ReactNode } from "react";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line-soft py-3 first:border-t-0">
      <h4 className="m-0 mb-2 text-micro font-bold uppercase tracking-[0.13em] text-muted-2">
        {title}
      </h4>
      {children}
    </section>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="m-0 grid grid-cols-[86px_1fr] gap-y-1.5 text-meta">
      {rows.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-muted-2">{key}</dt>
          <dd className="m-0 break-all text-ink">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
