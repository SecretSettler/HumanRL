import Image from "next/image";
import Link from "next/link";

export default function PrototypePage() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1080px] flex-col gap-4 px-6 py-8">
      <header className="flex items-baseline gap-3">
        <div className="flex-1 leading-tight">
          <p className="m-0 text-micro font-bold uppercase tracking-[0.13em] text-muted-2">
            Historical visual reference · v0.1
          </p>
          <h1 className="m-0 mt-1 text-lead font-bold tracking-tight">IntentTrace UI 原型</h1>
        </div>
        <Link href="/traces" className="text-meta no-underline hover:underline">
          ← 返回 Trace 列表
        </Link>
      </header>
      <p
        role="note"
        className="m-0 rounded-panel border border-amber/40 bg-panel/70 px-4 py-2.5 text-meta text-amber"
      >
        非产品、非测试证据：图中所有数据、模型、成本、连接状态与测试结果均为 fixture，
        本页只定义视觉方向，不执行原 HTML 中的任何 mock 行为。
      </p>
      <div className="overflow-auto rounded-panel border border-line bg-[#05070c]">
        <Image
          src="/intenttrace_ui_preview.png"
          alt="IntentTrace 三栏布局视觉原型：Trace 列表、Intent Graph、Gantt 与 Evidence Inspector"
          width={1800}
          height={1400}
          className="block h-auto w-full min-w-[900px]"
          priority
        />
      </div>
    </div>
  );
}
