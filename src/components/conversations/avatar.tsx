import { initials } from '@/lib/conversations/display';
import { cn } from '@/lib/utils';

/** Initials in a circle. Decorative: the name is always rendered next to it, so it is hidden from assistive tech. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground', className)}
    >
      {initials(name)}
    </span>
  );
}
