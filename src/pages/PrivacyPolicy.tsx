import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel, OutboundLink } from '@/components/common';
import { ArrowLeft } from 'lucide-react';

export default function PrivacyPolicy() {
  const navigate = useNavigate();

  return (
    <div className="page-container max-w-2xl mx-auto">
      <div className="page-header">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Settings
        </button>
        <h2 className="page-title">Privacy Policy</h2>
        <p className="page-subtitle">Last updated: September 2026</p>
      </div>

      <Panel className="animate-fade-in">
        <div className="prose-sm space-y-4 text-xs text-muted-foreground leading-relaxed">
          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Overview</h3>
            <p>
              Prism is a desktop application developed by RainaCorp. It runs on your machine and has no
              accounts, no servers of its own, and no analytics. This policy states exactly what stays on
              your device, what can leave it, and when.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">What stays on your device</h3>
            <p>Everything Prism knows about you lives in its application data folder:</p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li><strong className="text-foreground">Settings</strong> — your preferences, including a proxy URL if you set one (stored as typed, so don't put credentials in it that you wouldn't store in a text file)</li>
              <li><strong className="text-foreground">Queue and history</strong> — the URLs, titles, thumbnails and file paths of what you downloaded</li>
              <li><strong className="text-foreground">Subscriptions</strong> — the channels/playlists you watch and which entries have been seen</li>
              <li><strong className="text-foreground">Log files</strong> — an application log in the system log folder and, when the player is used, an mpv log (<span className="font-mono">mpv.log</span>) in the application data folder. Both can contain URLs and file paths, and both stay local unless you choose to send them to someone</li>
              <li><strong className="text-foreground">Allowed folders</strong> — the download folders you picked in the folder dialog, kept in the system preferences folder</li>
            </ul>
            <p className="mt-2">
              None of this is transmitted anywhere. Delete it at any time by removing the application data
              folder or using "Reset to Defaults" in Settings.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Network activity</h3>
            <p>Prism connects to the internet only for:</p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li>Fetching metadata and media for URLs you provide (or that a subscription you created has found)</li>
              <li>BitTorrent transfers you start — a peer-to-peer protocol: other participants in a swarm can see your IP address, and by default Prism joins the DHT and asks your router to forward a port (both can be turned off in Settings → BitTorrent)</li>
              <li>Checking for application updates and, when you ask, updating the yt-dlp engine (both from GitHub)</li>
              <li>Fetching a torrent IP blocklist, if you configured one</li>
              <li>Opt-in crash reporting (below)</li>
            </ul>
            <p className="mt-2">
              If you set a proxy, video downloads go through it entirely; for torrents only peer connections
              do — DHT, trackers and UPnP still use your real address. The Settings page says so next to the field.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Crash reporting (off by default)</h3>
            <p>
              Settings → Diagnostics → Crash reporting sends a report to Sentry (a third-party error-tracking
              service) when Prism crashes. It is <strong className="text-foreground">off</strong> unless you turn it
              on. A report contains the error type and message, a stack trace of Prism's own code, the app version
              and your operating system. Before sending, Prism removes anything that looks like a URL or a file
              path, does not attach console output, browsing breadcrumbs or request data, and never includes your
              queue, history or settings. You can turn it off again at any time; nothing is sent while it's off.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Clipboard</h3>
            <p>
              With "Clipboard link detection" on (Settings → Notifications), Prism reads the clipboard when its
              window regains focus to offer a one-click fetch of a video link it finds there. The clipboard
              contents are never stored or transmitted. Turn the setting off and Prism never reads the clipboard
              on its own; the tray's "Paste &amp; Download" reads it only when you click it.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Browser cookies</h3>
            <p>
              If you choose a browser under Settings → Video → Browser cookies, the yt-dlp engine reads
              that browser's cookie store locally so sign-in-required videos work. Cookies are sent only to the
              site the video is on, exactly as your browser would send them, and never to RainaCorp or anyone else.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Browser extension</h3>
            <p>
              The optional Prism Downloader extension for Firefox, Edge and Chrome adds a toolbar button and
              a right-click menu. When you use one, it hands that page's or link's address to Prism on this
              computer, and Prism asks you to confirm before fetching anything. It asks for one permission,
              to add menu items, and collects nothing: it makes no network requests of its own, stores
              nothing, and has no analytics.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Third parties</h3>
            <p>
              Prism uses yt-dlp and an embedded BitTorrent engine to talk directly to the sites and swarms you
              choose; their operators see those requests. Updates and the yt-dlp engine are downloaded from
              GitHub. Crash reports, if enabled, go to Sentry. No other third party receives anything.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Updates to this policy</h3>
            <p>
              Changes are reflected in the "Last updated" date above and shipped with application updates.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Contact</h3>
            <p>
              For privacy-related questions, please contact us at{' '}
              <OutboundLink href="https://www.rainacorp.co.uk" className="text-primary hover:underline">
                rainacorp.co.uk
              </OutboundLink>.
            </p>
          </section>
        </div>
      </Panel>
    </div>
  );
}
