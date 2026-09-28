import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const isTauri = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  // Use relative paths so Tauri can load assets from the local filesystem.
  // PAGES_BASE is the GitHub Pages demo's path (/prism/), set by deploy-web.yml.
  base: isTauri ? "./" : process.env.PAGES_BASE || "/",
  server: {
    host: "::",
    port: 8080,
    strictPort: true,
    hmr: {
      overlay: false,
    },
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Tauri uses Chromium on Windows/Linux and WebKit on macOS
    target: isTauri ? "safari14" : "modules",
  },
  // Only VITE_ variables reach the page. TAURI_ was here too, which would
  // have inlined TAURI_SIGNING_PRIVATE_KEY (set in the release build's
  // environment) into the bundle the moment any code read import.meta.env
  // whole (REVIEW 2026-09-28). The page reads no TAURI_ variable.
  envPrefix: ["VITE_"],
});
