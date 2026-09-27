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
  // Env vars prefixed with TAURI_ are exposed to the frontend
  envPrefix: ["VITE_", "TAURI_"],
});
