import type { ReactNode } from "react";

export function Panel({ title, right, children, className = "" }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel p-3 ${className}`}>
      {(title || right) && (
        <header className="mb-2 flex items-center justify-between gap-2">
          <h2 className="panel-title">{title}</h2>
          {right && <div className="text-xs text-muted">{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
