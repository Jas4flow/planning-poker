#!/usr/bin/env node

/**
 * Quick-start example for Planning Poker Cleanup Service
 * 
 * Usage:
 *   node start-cleanup.mjs
 * 
 * Environment variables (set in .env or export):
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY=your_service_role_key
 *   CLEANUP_INTERVAL=86400000   (optional, default: 24 hours)
 *   DAYS_TO_KEEP=30             (optional, default: 30 days)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if it exists
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, "utf-8");
  envContent.split("\n").forEach((line) => {
    const [key, value] = line.split("=");
    if (key && !key.startsWith("#") && !process.env[key.trim()]) {
      process.env[key.trim()] = value?.trim();
    }
  });
  console.log("✓ Loaded .env file");
}

// Check required environment variables
const required = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error("\n❌ Missing required environment variables:");
  missing.forEach((key) => {
    console.error(`   ${key}`);
  });
  console.error("\n📋 Setup instructions:\n");
  console.error("1. Create a .env file in the project root:");
  console.error("   cat > .env << 'EOF'");
  console.error("   SUPABASE_URL=https://your-project.supabase.co");
  console.error("   SUPABASE_SERVICE_KEY=your_service_role_key");
  console.error("   CLEANUP_INTERVAL=86400000");
  console.error("   DAYS_TO_KEEP=30");
  console.error("   EOF");
  console.error("\n2. Get your credentials from: Supabase Dashboard → Settings → API");
  console.error("3. Use the Service Role key (not anon key)");
  console.error("\n");
  process.exit(1);
}

// Import and start cleanup service
console.log("🚀 Starting Planning Poker Cleanup Service...\n");
import("./cleanup.mjs");
