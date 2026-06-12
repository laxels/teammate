import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served as a static directory on a fleet host via Tailscale Serve; the page
// talks straight to Convex over its websocket client. Runtime config
// (deployment URL + dashboard secret) comes from /config.json, written on
// the host by scripts/deploy-dashboard.sh — never bundled.
export default defineConfig({
  plugins: [react()],
});
