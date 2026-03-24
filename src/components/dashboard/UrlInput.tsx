import React, { useState, useRef, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { ClipboardPaste, Link2, Loader2, AlertCircle, FileText, ListPlus } from 'lucide-react';

interface UrlInputProps {
  onSubmit: (url: string) => void;
  onBatchSubmit?: (urls: string[]) => void;
  isLoading?: boolean;
  error?: string | null;
}

function extractUrls(text: string): string[] {
  return text
    .split(/[\n\r]+/)
    .map(line => line.trim())
    .filter(line => line.length > 4 && /^https?:\/\//i.test(line));
}

export function UrlInput({ onSubmit, onBatchSubmit, isLoading, error }: UrlInputProps) {
  const [url, setUrl] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [batchCount, setBatchCount] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    // Check for multiple URLs (newline-separated)
    const urls = extractUrls(trimmed);
    if (urls.length > 1 && onBatchSubmit) {
      onBatchSubmit(urls);
      setUrl('');
      setBatchCount(urls.length);
      setTimeout(() => setBatchCount(null), 3000);
    } else if (trimmed) {
      onSubmit(trimmed);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const urls = extractUrls(text);
      if (urls.length > 1 && onBatchSubmit) {
        onBatchSubmit(urls);
        setBatchCount(urls.length);
        setTimeout(() => setBatchCount(null), 3000);
      } else if (text.trim()) {
        setUrl(text.trim());
        onSubmit(text.trim());
      }
    } catch {
      inputRef.current?.focus();
    }
  };

  const handleFileRead = useCallback((file: File) => {
    if (!file.name.match(/\.(txt|text|csv|list|urls)$/i) && file.type !== 'text/plain') return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      if (!text) return;
      const urls = extractUrls(text);
      if (urls.length > 0 && onBatchSubmit) {
        onBatchSubmit(urls);
        setBatchCount(urls.length);
        setTimeout(() => setBatchCount(null), 3000);
      } else if (urls.length === 1) {
        setUrl(urls[0]);
        onSubmit(urls[0]);
      }
    };
    reader.readAsText(file);
  }, [onBatchSubmit, onSubmit]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    // Check for dropped files first
    if (e.dataTransfer.files.length > 0) {
      Array.from(e.dataTransfer.files).forEach(handleFileRead);
      return;
    }

    const text = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text/uri-list');
    if (text) {
      const urls = extractUrls(text);
      if (urls.length > 1 && onBatchSubmit) {
        onBatchSubmit(urls);
        setBatchCount(urls.length);
        setTimeout(() => setBatchCount(null), 3000);
      } else {
        const firstUrl = text.split('\n')[0]?.trim();
        if (firstUrl) {
          setUrl(firstUrl);
          onSubmit(firstUrl);
        }
      }
    }
  }, [onSubmit, onBatchSubmit, handleFileRead]);

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileRead(file);
    e.target.value = '';
  }, [handleFileRead]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
  };

  // Detect multi-line paste in input — just set text, don't auto-submit
  const handleInputPaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text/plain');
    const urls = extractUrls(text);
    if (urls.length > 1) {
      e.preventDefault();
      setUrl(text.trim());
    }
  }, []);

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
            onKeyDown={handleKeyDown}
            onPaste={handleInputPaste}
            aria-label="Video URL"
            placeholder="Paste a video URL to download..."
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
            disabled={isLoading}
          />
          {isLoading && <Loader2 className="w-4 h-4 text-primary animate-spin shrink-0" />}

          {/* Import file button */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.text,.csv,.list,.urls"
            className="hidden"
            onChange={handleFileInput}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            title="Import URLs from text file"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary/60 hover:bg-secondary text-xs font-medium text-secondary-foreground transition-colors active:scale-[0.97] disabled:opacity-50"
          >
            <FileText className="w-3.5 h-3.5" />
          </button>

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
            <div className="flex items-center gap-2">
              <ListPlus className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">Drop URLs or text file here</span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 mt-2.5 px-1 animate-fade-in">
          <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          <span className="text-xs text-destructive">{error}</span>
        </div>
      )}

      {batchCount && (
        <div className="flex items-center gap-2 mt-2.5 px-1 animate-fade-in">
          <ListPlus className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="text-xs text-primary">Queued {batchCount} URLs for parsing</span>
        </div>
      )}

      <p className="mt-2.5 px-1 text-[11px] text-muted-foreground/60">
        Supports single or multiple URLs · Drag and drop URLs or text files · Paste from clipboard
      </p>
    </div>
  );
}
