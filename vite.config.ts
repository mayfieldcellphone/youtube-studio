import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  root: "web",
  plugins: [react(), tailwindcss()],
  // Shown in the menu so it's easy to confirm which version is running.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: "../dist/client", emptyOutDir: true },
});
