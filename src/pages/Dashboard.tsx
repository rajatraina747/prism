import React, { useState, useCallback } from 'react';
import { useQueue } from '@/stores/AppProvider';
import { UrlInput } from '@/components/dashboard/UrlInput';
import { MediaDetailsModal } from '@/components/media-details/MediaDetailsModal';
import { EmptyState, Panel, StatusBadge, ProgressBar } from '@/components/common';
import { DEFAULT_PRESETS, type MediaMetadata, type DownloadItem } from '@/types/models';
import { mockParseUrl, formatBytes, formatDuration } from '@/services';
import {
  ArrowDownToLine, Sparkles, Clock, Zap,
} from 'lucide-react';

export default function Dashboard() {
  const { items: queueItems, addToQueue } = useQueue();
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [parsedMetadata, setParsedMetadata] = useState<MediaMetadata | null>(null);
  const [showMediaModal, setShowMediaModal] = useState(false);

  const activeDownloads = queueItems.filter(i => i.status === 'downloading');

  const handleUrlSubmit = useCallback(async (url: string) => {
    setParseError(null);
    setIsParsing(true);
    try {
      const metadata = await mockParseUrl(url);
      setParsedMetadata(metadata);
      setShowMediaModal(true);
    } catch (err: any) {
      setParseError(err.message || 'Failed to parse URL');
    } finally {
      setIsParsing(false);
    }
  }, []);

  const handleAddToQueue = useCallback((item: DownloadItem) => {
    addToQueue(item);
    setParsedMetadata(null);
  }, [addToQueue]);

  return (
    <div className="page-container max-w-3xl mx-auto">
      <div className="page-header">
        <h2 className="page-title">Dashboard</h2>
        <p className="page-subtitle">Paste a video URL to get started</p>
      </div>

      {/* URL Input */}
      <UrlInput onSubmit={handleUrlSubmit} isLoading={isParsing} error={parseError} />

      <div className="grid grid-cols-2 gap-4 mt-6">
        {/* Quick Presets */}
        <Panel title="Quick Presets" className="animate-fade-in" style={{ animationDelay: '100ms' } as React.CSSProperties}>
          <div className="flex flex-wrap gap-1.5">
            {DEFAULT_PRESETS.map(preset => (
              <span
                key={preset.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-secondary/60 text-[11px] font-medium text-secondary-foreground"
              >
                <Sparkles className="w-3 h-3 text-primary" />
                {preset.name}
              </span>
            ))}
          </div>
        </Panel>

        {/* Queue Snapshot */}
        <Panel title="Active Queue" className="animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
          {activeDownloads.length === 0 ? (
            <p className="text-xs text-muted-foreground/60 py-2">No active downloads</p>
          ) : (
            <div className="space-y-2">
              {activeDownloads.slice(0, 3).map(item => (
                <div key={item.id} className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-foreground truncate">{item.metadata.title}</p>
                    <ProgressBar value={item.progress} className="mt-1" />
                  </div>
                  <span className="text-[10px] tabular-nums text-muted-foreground shrink-0">
                    {item.progress.toFixed(0)}%
                  </span>
                </div>
              ))}
              {activeDownloads.length > 3 && (
                <p className="text-[10px] text-muted-foreground">+{activeDownloads.length - 3} more</p>
              )}
            </div>
          )}
        </Panel>
      </div>

      {/* Supported Formats Notice */}
      <div className="mt-6 px-4 py-3 rounded-xl bg-secondary/30 border border-border/20 animate-fade-in" style={{ animationDelay: '220ms' } as React.CSSProperties}>
        <div className="flex items-start gap-3">
          <Zap className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="text-xs font-medium text-foreground mb-0.5">Video download support</p>
            <p className="text-[11px] text-muted-foreground text-pretty leading-relaxed">
              Prism supports downloading videos from standard web URLs. The download engine is abstracted for future integration with lawful content sources. Resolution, format, and quality selection available per source.
            </p>
          </div>
        </div>
      </div>

      {/* Media Details Modal */}
      <MediaDetailsModal
        open={showMediaModal}
        onClose={() => setShowMediaModal(false)}
        metadata={parsedMetadata}
        onAddToQueue={handleAddToQueue}
      />
    </div>
  );
}
