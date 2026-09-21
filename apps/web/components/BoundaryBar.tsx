import Link from "next/link";

export function BoundaryBar() {
  return (
    <section
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-panel border border-line bg-panel/70 px-4 py-2.5 text-micro text-muted"
      aria-label="Deployment boundary"
    >
      <span className="font-bold uppercase tracking-[0.13em] text-muted-2">Local MVP</span>
      <span>默认无云 egress</span>
      <span aria-hidden>·</span>
      <span>single-host / no-auth</span>
      <span aria-hidden>·</span>
      <span>真实 session 只在你显式选择文件或目录后由本机 API 解析；服务端不扫描任何目录</span>
      <Link href="/prototype" className="ml-auto no-underline hover:underline">
        历史视觉原型 →
      </Link>
    </section>
  );
}
