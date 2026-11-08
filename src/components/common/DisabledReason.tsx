import React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Says why the button inside it can't be used. Pass no reason while it can.
 *
 * The wrapper is always there, so the button isn't remounted (and doesn't lose
 * focus) as it becomes available. It takes the hover and keyboard focus itself,
 * because a disabled button gets neither. It has its own provider because the
 * player window runs outside the app's. */
export function DisabledReason({ reason, className, children }: {
  reason?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={reason ? 0 : undefined}
            className={cn(
              'inline-flex rounded-lg',
              reason && 'cursor-not-allowed [&>button]:pointer-events-none',
              className,
            )}
          >
            {children}
          </span>
        </TooltipTrigger>
        {reason && <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">{reason}</TooltipContent>}
      </Tooltip>
    </TooltipProvider>
  );
}
