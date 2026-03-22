import React, { useState, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ClipboardPaste, Link2, Loader2, AlertCircle } from 'lucide-react';

interface UrlInputProps {
  onSubmit: (url: string) => void;
  isLoading?: boolean;
  error?: string | null;
}

export function UrlInput({ onSubmit, isLoading, error }: UrlInputProps) {
  const [url, setUrl] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const trimmed = url.trim();
    if (trimmed) onSubmit(trimmed);
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setUrl(text.trim());
        onSubmit(text.trim());
      }
    } catch {
      inputRef.current?.focus();
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
    if (text) {
      const firstUrl = text.split('\n')[0]?.trim();
      if (firstUrl) {
        setUrl(firstUrl);
        onSubmit(firstUrl);
      }
    }
  }, [onSubmit]);

  return (
    <div className="animate-fade-in">
      <div
        className={cn(
          'relative rounded-xl border transition-all duration-200',
          isDragOver
            ? 'border-primary/60 bg-primary/5 shadow-[0_0_0_3px_hsl(var(--primary)/0.1)]'
            : error
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-border/60 bg-card/50 hover:border-border focus-within:border-primary/40 focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.08)]'
        )}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <Link2 className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.8} />
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="Paste a video URL to download..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
            disabled={isLoading}
          />
          {isLoading && <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />}
          <button
            onClick={handlePaste}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 text-xs font-medium text-secondary-foreground transition-colors active:scale-[0.97] disabled:opacity-50"
          >
            <ClipboardPaste className="w-3.5 h-3.5" />
            Paste
          </button>
          <button
            onClick={handleSubmit}
            disabled={isLoading || !url.trim()}
            className="px-4 py-1.5 rounded-lg bg-primary hover:bg-primary/90 text-xs font-semibold text-primary-foreground transition-colors active:scale-[0.97] disabled:opacity-40"
          >
            {isLoading ? 'Parsing…' : 'Fetch'}
          </button>
        </div>

        {isDragOver && (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-primary/5 backdrop-blur-sm pointer-events-none">
            <span className="text-sm font-medium text-primary">Drop URL here</span>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 mt-2.5 px-1 animate-fade-in">
          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          <span className="text-xs text-destructive">{error}</span>
        </div>
      )}

      <p className="mt-2.5 px-1 text-[11px] text-muted-foreground/60">
        Supports standard video URLs · Drag and drop URLs or paste from clipboard
      </p>
    </div>
  );
}
