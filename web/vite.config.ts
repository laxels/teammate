import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In production the gateway serves web/dist itself, so /ws/* is same-origin.
// In dev, proxy the WebSocket endpoints to a locally running gateway.
export default defineConfig({
  plugins: [react()],
  // The shared transcript components live in ../shared; dedupe so that file and
  // this app bundle the same single React instance (react is hoisted to the
  // repo root so ../shared can resolve it, and is also present per-app).
  resolve: { dedupe: ["react", "react-dom"] },
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
