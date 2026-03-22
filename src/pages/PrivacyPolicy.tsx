import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '@/components/common';
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
        <p className="page-subtitle">Last updated: March 2026</p>
      </div>

      <Panel className="animate-fade-in">
        <div className="prose-sm space-y-4 text-xs text-muted-foreground leading-relaxed">
          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Overview</h3>
            <p>
              Prism is a desktop application developed by RainaCorp. We are committed to protecting your privacy.
              This policy explains what data Prism collects (or doesn't) and how it is handled.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Data Collection</h3>
            <p>
              Prism operates entirely on your local machine. We do <strong className="text-foreground">not</strong> collect,
              transmit, or store any personal data on external servers. Specifically:
            </p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li>No analytics or telemetry data is collected</li>
              <li>No account or registration is required</li>
              <li>No browsing history, download history, or URLs are sent to any server</li>
              <li>All application data (settings, queue, history) is stored locally on your device</li>
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Local Storage</h3>
            <p>
              Prism stores the following data locally on your device in the application data directory:
            </p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li><strong className="text-foreground">Settings</strong> — Your application preferences (theme, download folder, etc.)</li>
              <li><strong className="text-foreground">Download queue</strong> — Pending and active download items</li>
              <li><strong className="text-foreground">History</strong> — Records of completed downloads</li>
              <li><strong className="text-foreground">Diagnostic logs</strong> — Application logs stored in memory, cleared on restart</li>
            </ul>
            <p className="mt-2">
              This data never leaves your device and can be deleted at any time by removing the application data folder
              or using the "Reset to Defaults" option in Settings.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Network Activity</h3>
            <p>
              Prism makes network requests only when:
            </p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li>Fetching video metadata from URLs you provide</li>
              <li>Downloading video files you have explicitly requested</li>
              <li>Checking for application updates (if enabled in Settings)</li>
            </ul>
            <p className="mt-2">
              All network activity is initiated by you. No background data collection occurs.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Third-Party Services</h3>
            <p>
              Prism uses yt-dlp as its download engine. yt-dlp is an open-source tool that connects directly
              to video hosting platforms. Please refer to the privacy policies of the respective platforms for
              information on how they handle your requests.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Updates to This Policy</h3>
            <p>
              We may update this policy from time to time. Changes will be reflected in the "Last updated" date
              above and included in application updates.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">Contact</h3>
            <p>
              For privacy-related questions, please contact us at{' '}
              <a href="https://www.rainacorp.co.uk" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                rainacorp.co.uk
              </a>.
            </p>
          </section>
        </div>
      </Panel>
    </div>
  );
}
