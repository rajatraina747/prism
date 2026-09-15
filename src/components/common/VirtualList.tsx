import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';

interface VirtualListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Typical rendered height of one item in px; real heights are measured. */
  estimateSize: number;
  /** Space between items in px. */
  gap?: number;
  /** Up to this many items render plainly — windowing only pays off on long
   * lists, and plain lists keep tests and short pages simple. */
  threshold?: number;
  /** `parent`: the page's scrolling ancestor scrolls the list (Library).
   * `self`: this element scrolls — give it a max height (pickers). */
  scroll?: 'parent' | 'self';
  className?: string;
  role?: string;
  'aria-label'?: string;
}

/** A list that only mounts the rows near the viewport once it gets long
 * (a 2,000-entry Library, a 5,000-file torrent). */
export function VirtualList<T>(props: VirtualListProps<T>) {
  const { items, threshold = 60 } = props;
  return items.length > threshold ? <WindowedList {...props} /> : <PlainList {...props} />;
}

function PlainList<T>({ items, getKey, renderItem, gap = 6, scroll = 'parent', className, role, ...rest }: VirtualListProps<T>) {
  return (
    <div
      role={role}
      aria-label={rest['aria-label']}
      className={cn('flex flex-col', scroll === 'self' && 'overflow-y-auto', className)}
      style={{ gap }}
    >
      {items.map((item, i) => <React.Fragment key={getKey(item, i)}>{renderItem(item, i)}</React.Fragment>)}
    </div>
  );
}

function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? null;
}

function WindowedList<T>({
  items, getKey, renderItem, estimateSize, gap = 6, scroll = 'parent', className, role, ...rest
}: VirtualListProps<T>) {
  const selfRef = React.useRef<HTMLDivElement>(null);
  const innerRef = React.useRef<HTMLDivElement>(null);
  const [parent, setParent] = React.useState<HTMLElement | null>(null);
  const [margin, setMargin] = React.useState(0);

  // Where the list starts inside its scrolling ancestor. Re-measured after
  // every render so content appearing above it (a banner, a search box)
  // doesn't leave rows offset.
  React.useLayoutEffect(() => {
    if (scroll === 'self' || !innerRef.current) return;
    const p = parent ?? scrollParentOf(innerRef.current);
    if (p !== parent) setParent(p);
    if (!p) return;
    const m = innerRef.current.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop;
    if (Math.abs(m - margin) > 1) setMargin(m);
  });

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (scroll === 'self' ? selfRef.current : parent),
    estimateSize: () => estimateSize + gap,
    getItemKey: (i) => getKey(items[i], i),
    overscan: 8,
    scrollMargin: scroll === 'self' ? 0 : margin,
  });

  const inner = (
    <div
      ref={innerRef}
      role={role}
      aria-label={rest['aria-label']}
      style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map(vi => (
        <div
          key={vi.key}
          data-index={vi.index}
          ref={virtualizer.measureElement}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            paddingBottom: gap,
            transform: `translateY(${vi.start - virtualizer.options.scrollMargin}px)`,
          }}
        >
          {renderItem(items[vi.index], vi.index)}
        </div>
      ))}
    </div>
  );

  return scroll === 'self'
    ? <div ref={selfRef} className={cn('overflow-y-auto', className)}>{inner}</div>
    : <div className={className}>{inner}</div>;
}
