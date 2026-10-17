import { defineConfig } from "vitest/config";
import path from "path";

// SCRUM-594 simulated calls: their own config, so the normal `npx vitest run`
// never picks them up (they need an API key, cost money and take minutes).
export default defineConfig({
  root: path.resolve(__dirname, "../.."),
  test: {
    include: ["scripts/sim-calls/**/*.sim.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 3 * 60 * 60 * 1000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../../src"),
    },
  },
});
