import React from 'react';
import { cn } from '@/lib/utils';

/**
 * Have-pieces bar: one thin strip whose fill per bucket shows how much of
 * that part of the torrent is on disk. Rendered as a single CSS gradient
 * (200 stops) rather than 200 elements, so it's cheap enough for every row.
 */
export function PiecesBar({ pieces, className, height = 'h-1' }: { pieces?: number[]; className?: string; height?: string }) {
  const background = React.useMemo(() => {
    if (!pieces || pieces.length === 0) return undefined;
    const n = pieces.length;
    const stops = pieces.map((v, i) => {
      const a = (v / 255).toFixed(2);
      const from = ((i / n) * 100).toFixed(2);
      const to = (((i + 1) / n) * 100).toFixed(2);
      return `hsl(var(--primary) / ${a}) ${from}% ${to}%`;
    });
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [pieces]);

  if (!background) return null;
  return (
    <div
      role="img"
      aria-label="Downloaded pieces map"
      className={cn('w-full rounded-full bg-secondary overflow-hidden', height, className)}
      style={{ background: `${background}, hsl(var(--secondary))` }}
    />
  );
}
