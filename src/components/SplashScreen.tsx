import { useState, useEffect } from 'react';

interface SplashScreenProps {
  onFinished: () => void;
  minimumDuration?: number;
}

export function SplashScreen({ onFinished, minimumDuration = 2800 }: SplashScreenProps) {
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setFadeOut(true);
      // Wait for fade-out animation to complete before unmounting
      setTimeout(onFinished, 600);
    }, minimumDuration);
    return () => clearTimeout(timer);
  }, [minimumDuration, onFinished]);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-background transition-opacity duration-500 ${
        fadeOut ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div className="flex flex-col items-center gap-10">
        {/* Logos row */}
        <div className="flex items-center gap-8">
          <img
            src="/logo-nobg.png"
            alt="Prism"
            className="splash-logo-enter h-28 w-28 object-contain drop-shadow-[0_0_24px_hsl(160,50%,44%,0.35)]"
            style={{ animationDelay: '0.2s' }}
          />
          <div className="splash-divider-enter h-20 w-px bg-gradient-to-b from-transparent via-muted-foreground/30 to-transparent" />
          <img
            src="/rainacorp-logo.png"
            alt="RainaCorp"
            className="splash-logo-enter h-24 w-24 object-contain drop-shadow-[0_0_24px_hsl(45,80%,55%,0.3)]"
            style={{ animationDelay: '0.4s' }}
          />
        </div>

        {/* Brand text */}
        <div className="splash-text-enter flex flex-col items-center gap-1">
          <span className="text-lg font-semibold tracking-wide text-foreground">
            Prism
          </span>
          <span className="text-xs text-muted-foreground tracking-wider">
            by RainaCorp
          </span>
        </div>

        {/* Loading bar */}
        <div className="splash-bar-enter w-64">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted/50">
            <div className="splash-progress h-full rounded-full bg-gradient-to-r from-primary via-primary/80 to-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
