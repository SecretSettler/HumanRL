import { AppHeader } from "@/components/AppHeader";
import { BoundaryBar } from "@/components/BoundaryBar";
import { ImportWorkspace } from "@/components/import/ImportWorkspace";

export default function ImportPage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col gap-4 px-6 py-8">
      <AppHeader />
      <BoundaryBar />
      <ImportWorkspace />
    </div>
  );
}
