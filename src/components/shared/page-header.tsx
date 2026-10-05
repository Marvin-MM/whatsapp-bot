import type { ReactNode } from 'react';

export function PageHeader({ title, description, actions, hideDescriptionOnPhone = false }: { title: string; description?: string; actions?: ReactNode; hideDescriptionOnPhone?: boolean }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h1>
        {description ? <p className={hideDescriptionOnPhone ? 'mt-1 hidden text-sm text-muted-foreground sm:block' : 'mt-1 text-sm text-muted-foreground'}>{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
