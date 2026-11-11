import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolveNeonAuthUrl } from "./src/lib/auth-config";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const env = loadEnv(mode, process.cwd(), "VITE_");
    resolveNeonAuthUrl(env.VITE_NEON_AUTH_URL, true);
  }
  return {
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  };
});
