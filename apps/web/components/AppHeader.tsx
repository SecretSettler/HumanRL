"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { HealthPanel } from "@/app/health-panel";

const sections = [
  { href: "/traces", label: "Traces" },
  { href: "/import", label: "Import" },
];

export function AppHeader() {
  const pathname = usePathname();
  return (
    <header className="flex items-center gap-3">
      <span
        aria-hidden
        className="grid size-[30px] place-items-center rounded-[9px] bg-[conic-gradient(from_180deg,#8b7cf6,#59b6ff,#49d6d0,#8b7cf6)] p-[2px]"
      >
        <span className="grid size-full place-items-center rounded-[7px] bg-bg text-meta font-bold text-ink">
          ◎
        </span>
      </span>
      <div className="leading-tight">
        <h1 className="m-0 text-lead font-bold tracking-tight">IntentTrace</h1>
        <p className="m-0 text-micro text-muted-2">Evidence-backed agent traces</p>
      </div>
      <nav aria-label="Sections" className="ml-4 flex items-center gap-1">
        {sections.map((section) => {
          const current = pathname === section.href || pathname.startsWith(`${section.href}/`);
          return (
            <Link
              key={section.href}
              href={section.href}
              aria-current={current ? "page" : undefined}
              className={`rounded-[9px] px-3 py-1.5 text-meta font-semibold no-underline ${
                current
                  ? "border border-accent/50 bg-panel-3 text-ink"
                  : "border border-transparent text-muted hover:text-ink"
              }`}
            >
              {section.label}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto">
        <HealthPanel />
      </div>
    </header>
  );
}
