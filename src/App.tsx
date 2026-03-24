import { useState, useCallback } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceProvider } from "@/services/ServiceProvider";
import { AppProvider } from "@/stores/AppProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";
import { SplashScreen } from "@/components/SplashScreen";
import Dashboard from "@/pages/Dashboard";
import Queue from "@/pages/Queue";
import Downloads from "@/pages/Downloads";
import Failed from "@/pages/Failed";
import History from "@/pages/History";
import Settings from "@/pages/Settings";
import About from "@/pages/About";
import PrivacyPolicy from "@/pages/PrivacyPolicy";
import TermsOfService from "@/pages/TermsOfService";
import OpenSourceLicenses from "@/pages/OpenSourceLicenses";
import NotFound from "@/pages/NotFound";

const App = () => {
  const [showSplash, setShowSplash] = useState(true);
  const handleSplashFinished = useCallback(() => setShowSplash(false), []);

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      {showSplash && <SplashScreen onFinished={handleSplashFinished} />}
      <ServiceProvider>
        <TooltipProvider>
          <Sonner />
          <BrowserRouter>
            <AppProvider>
            <AppShell>
              <ErrorBoundary>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/queue" element={<Queue />} />
                <Route path="/downloads" element={<Downloads />} />
                <Route path="/failed" element={<Failed />} />
                <Route path="/history" element={<History />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/about" element={<About />} />
                <Route path="/privacy" element={<PrivacyPolicy />} />
                <Route path="/terms" element={<TermsOfService />} />
                <Route path="/licenses" element={<OpenSourceLicenses />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
              </ErrorBoundary>
            </AppShell>
            </AppProvider>
          </BrowserRouter>
        </TooltipProvider>
      </ServiceProvider>
    </ThemeProvider>
  );
};

export default App;
