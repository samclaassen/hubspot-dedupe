// Loads both .env.local and .env so DATABASE_URL can live next to HUBSPOT_ACCESS_TOKEN.
// .env.local takes precedence, matching Next.js's own env loading order.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
