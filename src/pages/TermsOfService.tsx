import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '@/components/common';
import { ArrowLeft } from 'lucide-react';

export default function TermsOfService() {
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
        <h2 className="page-title">Terms of Service</h2>
        <p className="page-subtitle">Last updated: March 2026</p>
      </div>

      <Panel className="animate-fade-in">
        <div className="prose-sm space-y-4 text-xs text-muted-foreground leading-relaxed">
          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">1. Acceptance of Terms</h3>
            <p>
              By installing, accessing, or using Prism ("the Application"), you agree to be bound by these
              Terms of Service. If you do not agree to these terms, do not use the Application.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">2. Description of Service</h3>
            <p>
              Prism is a desktop video download manager developed by RainaCorp. It provides a graphical
              interface for downloading publicly available video content from the internet using the
              open-source yt-dlp engine.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">3. Lawful Use</h3>
            <p>
              You agree to use Prism only for lawful purposes and in compliance with all applicable laws
              and regulations. Specifically, you agree:
            </p>
            <ul className="list-disc pl-4 space-y-1 mt-2">
              <li>To only download content you have the legal right to access and save</li>
              <li>Not to use Prism to circumvent digital rights management (DRM) or copy protection</li>
              <li>Not to use Prism to infringe upon the intellectual property rights of others</li>
              <li>To comply with the terms of service of any platform from which you download content</li>
              <li>To respect all applicable copyright laws in your jurisdiction</li>
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">4. User Responsibility</h3>
            <p>
              You are solely responsible for any content you download using Prism. RainaCorp does not
              monitor, control, or endorse any content accessed through the Application. You bear full
              responsibility for ensuring your use complies with applicable laws.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">5. Intellectual Property</h3>
            <p>
              The Prism application, including its design, code, and branding, is the intellectual property
              of RainaCorp. You may not reproduce, distribute, modify, or create derivative works based on
              the Application without prior written consent.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">6. Disclaimer of Warranties</h3>
            <p>
              Prism is provided "as is" without warranties of any kind, express or implied. RainaCorp does
              not warrant that the Application will be error-free, uninterrupted, or free of harmful components.
              Use of the Application is at your own risk.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">7. Limitation of Liability</h3>
            <p>
              To the maximum extent permitted by law, RainaCorp shall not be liable for any indirect,
              incidental, special, consequential, or punitive damages arising from your use of the
              Application, including but not limited to loss of data, loss of profits, or legal claims
              resulting from downloaded content.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">8. Termination</h3>
            <p>
              RainaCorp reserves the right to modify, suspend, or discontinue the Application at any time
              without notice. You may stop using the Application at any time by uninstalling it from your device.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">9. Changes to Terms</h3>
            <p>
              We may update these terms from time to time. Continued use of Prism after changes constitutes
              acceptance of the revised terms. Material changes will be communicated through application updates.
            </p>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground mb-2">10. Contact</h3>
            <p>
              For questions regarding these terms, please contact us at{' '}
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
