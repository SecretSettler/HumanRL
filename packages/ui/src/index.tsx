import type { ButtonHTMLAttributes, ReactNode } from "react";

export { CopyButton } from "./copy-button.js";

export type StatusTone = "neutral" | "ok" | "warning" | "blocked";

const toneLabels: Record<StatusTone, string> = {
  neutral: "Informational status",
  ok: "Healthy status",
  warning: "Warning status",
  blocked: "Blocked status",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`status-badge status-badge--${tone}`} aria-label={toneLabels[tone]}>
      {children}
    </span>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export function Button({
  variant = "secondary",
  className,
  type,
  ...props
}: { variant?: ButtonVariant } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={type ?? "button"}
      className={`ui-button ui-button--${variant}${className ? ` ${className}` : ""}`}
    />
  );
}

export type BannerTone = "info" | "warning" | "danger" | "success";

export function Banner({
  tone,
  role = "status",
  className,
  children,
}: {
  tone: BannerTone;
  role?: "status" | "alert";
  className?: string;
  children: ReactNode;
}) {
  return (
    <p role={role} className={`ui-banner ui-banner--${tone}${className ? ` ${className}` : ""}`}>
      {children}
    </p>
  );
}

export function Chip({
  selected,
  className,
  type,
  ...props
}: { selected: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={type ?? "button"}
      aria-pressed={selected}
      className={`ui-chip${className ? ` ${className}` : ""}`}
    />
  );
}
