import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider } from "next-themes";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServiceProvider } from "@/services/ServiceProvider";
import { AppProvider } from "@/stores/AppProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppShell } from "@/components/layout/AppShell";
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

const queryClient = new QueryClient();

const App = () => (
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
    <ServiceProvider>
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>
    </ServiceProvider>
  </ThemeProvider>
);

export default App;
