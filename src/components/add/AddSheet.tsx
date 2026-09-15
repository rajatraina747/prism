import React, { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useService } from '@/services/ServiceProvider';
import { extractLinks } from '@/lib/add-links';
import { toast } from 'sonner';
import { ClipboardPaste, FileText, Magnet } from 'lucide-react';

export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

/** The one place to add anything: video and playlist links, magnets, a
 * .torrent file, or a text file of links. Opened from the sidebar or with
 * ⌘N / ⌘L from any page; drops anywhere in the window take the same path. */
export function AddSheet({ open, onOpenChange, onAdd }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (links: string[]) => void;
}) {
  const service = useService();
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const links = extractLinks(text);

  React.useEffect(() => { if (!open) setText(''); }, [open]);

  const submit = (list: string[]) => {
    if (list.length === 0) return;
    onAdd(list);
    onOpenChange(false);
  };

  const append = (more: string[]) => {
    if (more.length === 0) return;
    setText(t => [t.trim(), ...more].filter(Boolean).join('\n'));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-border/40 bg-card">
        <DialogHeader>
          <DialogTitle className="text-base">Add downloads</DialogTitle>
          <DialogDescription className="text-xs">
            Video or playlist links and magnet links, one per line. You can also drop links, .torrent files or a text file anywhere in the window.
          </DialogDescription>
        </DialogHeader>

        <textarea
          autoFocus
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit(links);
            }
          }}
          aria-label="Links to add"
          placeholder={'https://www.youtube.com/watch?v=…\nmagnet:?xt=urn:btih:…'}
          spellCheck={false}
          rows={5}
          className="w-full resize-none rounded-lg bg-input border border-border/40 px-3 py-2 text-xs font-mono text-foreground outline-none focus:border-primary/40 placeholder:text-muted-foreground/50"
        />

        <input
          ref={fileRef}
          type="file"
          accept=".txt,.text,.csv,.list,.urls,.torrent"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            try {
              if (/\.torrent$/i.test(file.name)) {
                append([await service.importTorrentFile(file.name, new Uint8Array(await file.arrayBuffer()))]);
              } else {
                const found = extractLinks(await file.text());
                if (found.length === 0) toast.error(`No links found in ${file.name}`);
                append(found);
              }
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        />

        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={async () => {
              const clip = await service.readClipboard().catch(() => '');
              const found = extractLinks(clip);
              if (found.length === 0) toast.error('No links on the clipboard');
              append(found);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
          >
            <ClipboardPaste className="w-3.5 h-3.5" /> Paste
          </button>
          {!service.isDemo && (
            <button
              type="button"
              onClick={async () => {
                const path = await service.pickTorrentFile().catch(() => null);
                if (path) submit([path]);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
            >
              <Magnet className="w-3.5 h-3.5" /> Open .torrent…
            </button>
          )}
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors"
          >
            <FileText className="w-3.5 h-3.5" /> {service.isDemo ? 'Import file…' : 'Import list…'}
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums" aria-live="polite">
            {links.length === 0 ? '' : `${links.length} link${links.length === 1 ? '' : 's'}`}
          </span>
          <button
            type="button"
            disabled={links.length === 0}
            onClick={() => submit(links)}
            title={`${MOD_KEY}Enter`}
            className="px-4 py-1.5 rounded-lg bg-primary text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40"
          >
            {links.length > 1 ? `Add ${links.length}` : 'Add'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
