import { useState, useCallback, lazy, Suspense } from "react";
import { useService } from "@/services/ServiceProvider";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceProvider } from "@/services/ServiceProvider";
import { AppProvider } from "@/stores/AppProvider";
import { SubscriptionsProvider } from "@/stores/SubscriptionsProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";
import { SplashScreen } from "@/components/SplashScreen";
import Dashboard from "@/pages/Dashboard";
import NotFound from "@/pages/NotFound";

// The first screen is in the main bundle; every other page loads when it is
// first opened. All of them were one 686 KB chunk parsed at launch, the legal
// pages and the 1,267-line Settings included (REVIEW 2026-09-28 P-12).
const Queue = lazy(() => import("@/pages/Queue"));
const Subscriptions = lazy(() => import("@/pages/Subscriptions"));
const Library = lazy(() => import("@/pages/Library"));
const Settings = lazy(() => import("@/pages/Settings"));
const About = lazy(() => import("@/pages/About"));
const PrivacyPolicy = lazy(() => import("@/pages/PrivacyPolicy"));
const Statistics = lazy(() => import("@/pages/Statistics"));
const TermsOfService = lazy(() => import("@/pages/TermsOfService"));
const OpenSourceLicenses = lazy(() => import("@/pages/OpenSourceLicenses"));
import { routerBasename } from "@/lib/public-asset";

// Branded splash on the very first launch only — on every later launch the app
// is ready almost immediately (persistence preloads before render), so a fixed
// multi-second overlay is pure friction for a utility opened many times a day.
const SPLASH_SEEN_KEY = 'prism_splash_seen';

// The dedicated player window loads /player and must render ONLY the player:
// mounting the app providers there would spawn a second download orchestrator
// (AppProvider auto-start, subscription scheduler) alongside the main
// window's. Lazy so the main window never loads the mpv API at startup.
const PlayerWindow = lazy(() => import("@/pages/Player"));
const isPlayerWindow = window.location.pathname.endsWith("/player");

/** The splash, on a first launch only: nothing saved yet. The webview-storage
 * flag alone isn't enough, because that storage belongs to the bundle
 * identifier, which changed in 2.0 — upgraded users arrive with their
 * settings but an empty store. Settings are preloaded before this renders. */
function FirstRunSplash() {
  const service = useService();
  const [show, setShow] = useState(() => {
    try {
      if (localStorage.getItem(SPLASH_SEEN_KEY)) return false;
    } catch { /* private mode */ }
    return service.persistence.loadSettings() === null;
  });
  const finish = useCallback(() => {
    setShow(false);
    try { localStorage.setItem(SPLASH_SEEN_KEY, '1'); } catch { /* private mode */ }
  }, []);
  return show ? <SplashScreen onFinished={finish} /> : null;
}

const App = () => {
  if (isPlayerWindow) {
    return (
      <Suspense fallback={null}>
        <PlayerWindow />
      </Suspense>
    );
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <ServiceProvider>
        <FirstRunSplash />
        <TooltipProvider>
          <Sonner />
          <BrowserRouter basename={routerBasename()}>
            <AppProvider>
            <SubscriptionsProvider>
            <AppShell>
              <ErrorBoundary>
              <Suspense fallback={null}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/queue" element={<Queue />} />
                <Route path="/subscriptions" element={<Subscriptions />} />
                <Route path="/library" element={<Library />} />
                <Route path="/statistics" element={<Statistics />} />
                {/* Old routes — Downloads/Failed/History merged into Library */}
                <Route path="/downloads" element={<Navigate to="/library" replace />} />
                <Route path="/failed" element={<Navigate to="/library" replace />} />
                <Route path="/history" element={<Navigate to="/library" replace />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/about" element={<About />} />
                <Route path="/privacy" element={<PrivacyPolicy />} />
                <Route path="/terms" element={<TermsOfService />} />
                <Route path="/licenses" element={<OpenSourceLicenses />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </Suspense>
              </ErrorBoundary>
            </AppShell>
            </SubscriptionsProvider>
            </AppProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ServiceProvider>
    </ThemeProvider>
  );
};

export default App;
