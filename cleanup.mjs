/**
 * Background cleanup service for Planning Poker
 *
 * Deletes completed rooms older than 30 days automatically.
 * Runs as a background process and does NOT delete:
 *   - User profiles (pp_profiles)
 *   - User authentication data
 *
 * Run:  node cleanup.mjs
 * 
 * Environment variables:
 *   - SUPABASE_URL: Your Supabase project URL
 *   - SUPABASE_SERVICE_KEY: Your Supabase service role key (for server-side access)
 *   - CLEANUP_INTERVAL: Interval in milliseconds (default: 86400000 = 24 hours)
 *   - DAYS_TO_KEEP: Number of days before deletion (default: 30)
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLEANUP_INTERVAL = Number(process.env.CLEANUP_INTERVAL || 86400000); // 24 hours
const DAYS_TO_KEEP = Number(process.env.DAYS_TO_KEEP || 30);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/**
 * Delete completed rooms (rooms not updated for 30+ days)
 * Uses cascade delete to automatically remove pp_room_members entries
 */
async function cleanupOldRooms() {
  try {
    // Calculate the date 30 days ago
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - DAYS_TO_KEEP);

    console.log(
      `[${new Date().toISOString()}] Starting cleanup of rooms not updated since ${thirtyDaysAgo.toDateString()}...`
    );

    // Delete rooms with updated_at older than 30 days
    const { data, error, count } = await supabase
      .from("pp_rooms")
      .delete()
      .lt("updated_at", thirtyDaysAgo.toISOString())
      .select("id, name"); // Return deleted records for logging

    if (error) {
      console.error("Cleanup failed:", error);
      return;
    }

    if (count && count > 0) {
      console.log(`✓ Deleted ${count} old room(s):`);
      if (data) {
        data.forEach((room) => {
          console.log(`  - ${room.id} (${room.name})`);
        });
      }
    } else {
      console.log("✓ No rooms to clean up");
    }
  } catch (error) {
    console.error("Cleanup error:", error.message);
  }
}

/**
 * Optional: Get cleanup statistics
 */
async function getStats() {
  try {
    const { count: totalRooms, error: roomsError } = await supabase
      .from("pp_rooms")
      .select("id", { count: "exact", head: true });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - DAYS_TO_KEEP);

    const { count: oldRooms, error: oldError } = await supabase
      .from("pp_rooms")
      .select("id", { count: "exact", head: true })
      .lt("updated_at", thirtyDaysAgo.toISOString());

    if (!roomsError && !oldError) {
      console.log(`\nDatabase stats:`);
      console.log(`  Total rooms: ${totalRooms}`);
      console.log(`  Rooms eligible for deletion: ${oldRooms}`);
    }
  } catch (error) {
    console.error("Stats error:", error.message);
  }
}

/**
 * Start the cleanup service
 */
async function start() {
  console.log("Planning Poker Cleanup Service");
  console.log(`Interval: ${CLEANUP_INTERVAL / 1000 / 3600} hour(s)`);
  console.log(`Retention: ${DAYS_TO_KEEP} days`);
  console.log("Starting...\n");

  // Run cleanup immediately on start
  await cleanupOldRooms();
  await getStats();

  // Then run on schedule
  setInterval(async () => {
    await cleanupOldRooms();
  }, CLEANUP_INTERVAL);
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\n\nShutting down cleanup service...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n\nShutting down cleanup service...");
  process.exit(0);
});

start();
