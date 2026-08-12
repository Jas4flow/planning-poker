/**
 * Supabase connection.
 *
 * The publishable key is meant to sit in client code — it identifies the
 * project and nothing more. Every access rule is enforced by Row Level
 * Security in db/schema.sql, so this key on its own grants no data.
 *
 * Never put a `sb_secret_…` / service-role key here: it bypasses RLS entirely.
 */

export const SUPABASE_URL = "https://ywuxnuussttuhaizyogi.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Shx8IBolqwh-5QkDt2wIRg_S6OWjCCH";

/** Pinned so a CDN release cannot change the app under you. */
export const SUPABASE_JS = "https://esm.sh/@supabase/supabase-js@2.58.0";

/** Local overrides, for pointing a copy of the app at another project. */
const OVERRIDE_KEY = "pp:supabase";

export function connection() {
  let override = null;
  try {
    override = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "null");
  } catch {
    override = null;
  }
  return {
    url: override?.url || SUPABASE_URL,
    key: override?.key || SUPABASE_PUBLISHABLE_KEY,
  };
}

export function setConnection({ url, key }) {
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ url, key }));
}

export function clearConnection() {
  localStorage.removeItem(OVERRIDE_KEY);
}
