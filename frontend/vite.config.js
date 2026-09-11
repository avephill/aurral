import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { cwd } from "process";
import { resolveAppVersion } from "../lib/app-version.js";
import { normalizeBasePathWithTrailingSlash } from "./src/utils/basePath.js";

const appVersion = resolveAppVersion({
  envValue: globalThis?.process?.env?.VITE_APP_VERSION,
  cwd: process.cwd(),
});
const releaseChannel = globalThis?.process?.env?.VITE_RELEASE_CHANNEL || "stable";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, cwd(), "");
  const basePath = normalizeBasePathWithTrailingSlash(env.VITE_BASE_PATH || "/");
  const isDev = mode === "development";

  return {
    base: isDev ? "/" : basePath,
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      "import.meta.env.VITE_RELEASE_CHANNEL": JSON.stringify(releaseChannel),
    },
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["arralogo.svg", "icons/*.png", "spotify-oauth-callback.js", "offline.html"],
        workbox: {
          navigateFallback: null,
          directoryIndex: null,
          // Pages always come from the server, so an unreachable server would
          // otherwise show the browser's own error page. Installed as an app
          // that looks broken, so serve a plain page that says what happened.
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkOnly",
              options: {
                precacheFallback: { fallbackURL: `${basePath}offline.html` },
              },
            },
          ],
        },
        manifest: {
          // Installed on a desktop this becomes a real application: its own
          // window, its own icon, no address bar. Keep `id` stable so an
          // install survives later changes to the rest of the manifest.
          id: basePath,
          name: "Aurral Music",
          short_name: "Aurral",
          description: "Your music library, playlists and ratings",
          theme_color: "#ffffff",
          background_color: "#ffffff",
          display: "standalone",
          display_override: ["standalone", "minimal-ui"],
          scope: basePath,
          start_url: basePath,
          // Clicking the icon returns to the window that is already open
          // rather than starting a second one.
          launch_handler: { client_mode: "navigate-existing" },
          icons: [
            {
              src: `${basePath}icons/aurral-192.png`,
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${basePath}icons/aurral-512.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: `${basePath}icons/aurral-512-maskable.png`,
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
            {
              src: `${basePath}icons/aurral-icon-iOS-Default-1024x1024@1x.png`,
              sizes: "1024x1024",
              type: "image/png",
              purpose: "any",
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: "http://localhost:3001",
          changeOrigin: false,
          xfwd: true,
          secure: false,
          ws: true,
          timeout: 60000,
          proxyTimeout: 60000,
        },
        "/sso/callback": {
          target: "http://localhost:3001",
          changeOrigin: true,
          xfwd: true,
          secure: false,
        },
        "/ws": {
          target: "ws://localhost:3001",
          ws: true,
        },
      },
    },
  };
});
