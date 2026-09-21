import type { ReactNode } from "react";

export function WorkbenchShell({
  topbar,
  sidebar,
  main,
  inspector,
  inspectorOpen,
}: {
  topbar: ReactNode;
  sidebar: ReactNode;
  main: ReactNode;
  inspector: ReactNode;
  inspectorOpen: boolean;
}) {
  return (
    <div className="workbench-shell grid h-dvh grid-rows-[58px_minmax(0,1fr)] overflow-hidden">
      {topbar}
      <div className="grid min-h-0 grid-cols-[240px_minmax(0,1fr)_338px] max-[1279px]:grid-cols-[minmax(0,1fr)]">
        <aside
          className="workbench-sidebar min-h-0 overflow-y-auto border-r border-line bg-panel/92"
          aria-label="Trace navigation"
          data-testid="trace-sidebar"
        >
          {sidebar}
        </aside>
        <main
          className="workbench-main flex min-h-0 flex-col overflow-y-auto"
          aria-label="Trace workbench"
        >
          {main}
        </main>
        <aside
          className={`workbench-inspector min-h-0 overflow-y-auto border-l border-line bg-panel/92${inspectorOpen ? " workbench-inspector--open" : ""}`}
          aria-label="Evidence inspector"
        >
          {inspector}
        </aside>
      </div>
    </div>
  );
}
