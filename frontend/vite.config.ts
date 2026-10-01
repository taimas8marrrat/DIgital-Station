import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// VITE_SOURCE=server — интерфейс Python-сервиса (frontend/dist); иначе — сайт одним HTML-файлом.
const server = process.env.VITE_SOURCE === "server";
export default defineConfig({
  plugins: server ? [react()] : [react(), viteSingleFile()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8000", "/health": "http://localhost:8000", "/ws": { target: "ws://localhost:8000", ws: true } } },
  build: server ? { chunkSizeWarningLimit: 5000 } : { assetsInlineLimit: 100000000, chunkSizeWarningLimit: 5000, cssCodeSplit: false },
});
