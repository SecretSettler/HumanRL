import { TraceWorkbench } from "./trace-workbench";

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  return <TraceWorkbench traceId={(await params).traceId} />;
}
