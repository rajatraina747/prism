import React, { useState } from 'react';
import { useHistory } from '@/stores/AppProvider';
import { EmptyState, Panel } from '@/components/common';
import { formatBytes, formatDuration } from '@/services';
import {
  CheckCircle2, FolderOpen, RotateCcw, Trash2, ExternalLink,
  Copy, Search,
} from 'lucide-react';

export default function Downloads() {
  const { items, removeFromHistory } = useHistory();
  const [search, setSearch] = useState('');

  const completed = items
    .filter(i => i.status === 'completed')
    .filter(i => !search || i.metadata.title.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Completed Downloads</h2>
          <p className="page-subtitle">{completed.length} file{completed.length !== 1 ? 's' : ''} downloaded</p>
        </div>
      </div>

      {/* Search */}
      {items.filter(i => i.status === 'completed').length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-input border border-border/40 mb-4 max-w-sm">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search downloads..."
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/50 outline-none"
          />
        </div>
      )}

      {completed.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No completed downloads yet"
          description="Finished downloads will appear here. Start by adding a video URL from the Dashboard."
        />
      ) : (
        <div className="space-y-1.5">
          {completed.map((item, i) => (
            <div
              key={item.id}
              className="glass-strong rounded-xl p-3.5 flex items-center gap-3 animate-fade-in"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <img src={item.metadata.thumbnail} alt="" className="w-16 h-10 rounded-md object-cover bg-secondary shrink-0" />
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
                <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground tabular-nums">
                  <span>{item.settings.format?.resolution} · {item.settings.format?.container.toUpperCase()}</span>
                  <span>{formatBytes(item.fileSize)}</span>
                  <span>{formatDuration(item.metadata.duration)}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button title="Open file" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]">
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
                <button title="Show in folder" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]">
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
                <button title="Copy source URL" className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]">
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button title="Remove" onClick={() => removeFromHistory(item.id)} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95]">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
