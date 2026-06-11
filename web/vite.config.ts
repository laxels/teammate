import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In production the gateway serves web/dist itself, so /ws/* is same-origin.
// In dev, proxy the WebSocket endpoints to a locally running gateway.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": {
        target: "ws://localhost:8787",
        ws: true,
      },
    },
  },
});
