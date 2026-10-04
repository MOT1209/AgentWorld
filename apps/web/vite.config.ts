import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        // Keep the heavy 3D dependency out of the initial bundle: it only loads
        // when the lazily-mounted SimulationView is opened.
        manualChunks: {
          three: ["three"],
        },
      },
    },
  },
});
