import { useState, useCallback, lazy, Suspense } from "react";
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
import Queue from "@/pages/Queue";
import Subscriptions from "@/pages/Subscriptions";
import Library from "@/pages/Library";
import Settings from "@/pages/Settings";
import About from "@/pages/About";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import TermsOfService from "@/pages/TermsOfService";
import OpenSourceLicenses from "@/pages/OpenSourceLicenses";
import NotFound from "@/pages/NotFound";

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

const App = () => {
  const [showSplash, setShowSplash] = useState(() => {
    try { return !localStorage.getItem(SPLASH_SEEN_KEY); } catch { return true; }
  });
  const handleSplashFinished = useCallback(() => {
    setShowSplash(false);
    try { localStorage.setItem(SPLASH_SEEN_KEY, '1'); } catch { /* private mode */ }
  }, []);

  if (isPlayerWindow) {
    return (
      <Suspense fallback={null}>
        <PlayerWindow />
      </Suspense>
    );
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      {showSplash && <SplashScreen onFinished={handleSplashFinished} />}
      <ServiceProvider>
        <TooltipProvider>
          <Sonner />
          <BrowserRouter>
            <AppProvider>
            <SubscriptionsProvider>
            <AppShell>
              <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/queue" element={<Queue />} />
                <Route path="/subscriptions" element={<Subscriptions />} />
                <Route path="/library" element={<Library />} />
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
