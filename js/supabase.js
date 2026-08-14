/**
 * Everything that talks to Supabase: auth, rooms, membership.
 *
 * Access rules are not implemented here — they live in db/schema.sql as Row
 * Level Security policies. This module only makes the requests; Postgres
 * decides what comes back. A hostile client cannot read another person's room
 * by calling these functions differently.
 */

import { connection, SUPABASE_JS } from "./config.js";

let clientPromise = null;

/** The supabase-js client, loaded from the CDN on first use. */
export async function client() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const { createClient } = await import(/* @vite-ignore */ SUPABASE_JS);
      const { url, key } = connection();
      return createClient(url, key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
        realtime: { params: { eventsPerSecond: 20 } },
      });
    })();
  }
  return clientPromise;
}

export class SupabaseError extends Error {
  constructor(message, { code = "", hint = "" } = {}) {
    super(message);
    this.name = "SupabaseError";
    this.code = code;
    this.hint = hint;
  }
}

/** Turn a PostgREST/GoTrue error into something a facilitator can act on. */
export function describe(error, fallback = "Something went wrong.") {
  if (!error) return fallback;
  const code = error.code || "";
  const message = error.message || String(error);

  if (/Failed to fetch|NetworkError/i.test(message)) {
    return "Cannot reach Supabase. Check your connection, and that the project URL in js/config.js is right.";
  }
  if (code === "42P01" || code === "PGRST205" || /relation .* does not exist|schema cache/i.test(message)) {
    return "The database tables are missing. Open Supabase → SQL Editor and run db/schema.sql once.";
  }
  if (code === "PGRST202" || /function .* does not exist/i.test(message)) {
    return "The pp_join_room / pp_room_preview functions are missing. Run db/schema.sql in the Supabase SQL editor.";
  }
  if (code === "42501" || /row-level security/i.test(message)) {
    return "The database refused this — you are not a member of that session. Ask the host for the invite link.";
  }
  if (/anonymous sign-ins are disabled/i.test(message)) {
    return "Anonymous sign-in is switched off for this project. Enable it in Supabase → Authentication → Providers → Anonymous.";
  }
  if (/invite not found/i.test(message)) {
    return "That invite link is not valid any more.";
  }
  if (/email not confirmed|email_not_confirmed/i.test(message)) {
    return 'This account was created while "Confirm email" was still on, so Supabase considers it unconfirmed. Turning the setting off does not fix accounts that already exist — run db/confirm-existing-users.sql in the SQL editor, or delete the user under Authentication → Users and sign up again.';
  }
  if (/signups? not allowed|signup_disabled/i.test(message)) {
    return "New sign-ups are switched off for this project. Enable them in Supabase → Authentication → Sign In / Providers → Email.";
  }
  if (/password.*(short|least|weak)/i.test(message)) {
    return "That password is too short — Supabase wants at least 6 characters.";
  }
  if (/token has expired|otp_expired|invalid.*token|token.*invalid/i.test(message)) {
    return "That code is wrong or has expired — codes last one hour. Send a new one.";
  }
  if (/same.*password|should be different/i.test(message)) {
    return "The new password has to be different from the old one.";
  }
  if (/auth session missing|session_not_found/i.test(message)) {
    return "The reset session expired. Send a new code and try again.";
  }
  if (/rate limit|too many requests/i.test(message)) {
    return 'Supabase is rate-limiting this. If it happened while creating an account, the cause is usually "Confirm email" being switched on — every sign-up then sends a mail, and the free tier allows very few. Turn it off in Authentication → Sign In / Providers → Email.';
  }
  return message || fallback;
}

function unwrap(result, fallback) {
  if (result.error) throw new SupabaseError(describe(result.error, fallback), { code: result.error.code });
  return result.data;
}

/* ---------------------------------------------------------------- auth ---- */

export async function currentSession() {
  const supabase = await client();
  const { data } = await supabase.auth.getSession();
  return data.session || null;
}

export async function currentUser() {
  const session = await currentSession();
  return session?.user || null;
}

/** True for accounts created by signInAnonymously — no email, cannot come back. */
export function isGuest(user) {
  if (!user) return true;
  return user.is_anonymous === true || !user.email;
}

/**
 * @param {(session: object|null, event: string) => void} handler
 *   `event` is "PASSWORD_RECOVERY" when a reset link was opened — the fragment
 *   that carried it is consumed by supabase-js, so this is the only signal.
 */
export async function onAuthChange(handler) {
  const supabase = await client();
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // supabase-js holds an internal auth lock for as long as this callback is
    // running. Calling getSession(), updateUser() or signOut() from inside it
    // waits for a lock that cannot be released until the callback returns —
    // the call never settles, and every later auth call queues behind it.
    // Handing the work to a timeout gets us out of the callback first.
    setTimeout(() => handler(session, event), 0);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * One door for hosts: sign in if the account exists, create it and sign in if
 * it does not. No email round trip.
 *
 * A password is required because an email address on its own is not a
 * credential — without one, anybody who typed your address would inherit your
 * sessions.
 *
 * @returns {Promise<{user: object, created: boolean}>}
 */
export async function signInOrSignUp(email, password, displayName) {
  const supabase = await client();
  const address = String(email || "").trim().toLowerCase();
  const secret = String(password || "");

  if (!address) throw new SupabaseError("Enter your email address.");
  if (secret.length < 6) throw new SupabaseError("The password must be at least 6 characters.");

  const existing = await supabase.auth.signInWithPassword({ email: address, password: secret });
  if (!existing.error) {
    if (displayName) await setDisplayName(displayName);
    return { user: existing.data.user, created: false };
  }

  // Not "wrong password" territory yet — the account may simply not exist.
  if (!/invalid login credentials/i.test(existing.error.message || "")) {
    throw new SupabaseError(describe(existing.error, "Could not sign in."), { code: existing.error.code });
  }

  const fresh = await supabase.auth.signUp({
    email: address,
    password: secret,
    options: { data: { display_name: displayName || address.split("@")[0] } },
  });

  if (fresh.error) {
    if (/already registered|already exists/i.test(fresh.error.message || "")) {
      throw new SupabaseError(
        `An account already exists for ${address}, and that password does not match it.`,
        { code: "wrong_password" }
      );
    }
    throw new SupabaseError(describe(fresh.error, "Could not create the account."), { code: fresh.error.code });
  }

  if (!fresh.data.session) {
    // Supabase is set to demand a confirmation click before the first sign-in.
    throw new SupabaseError(
      'The account was created, but Supabase is set to require email confirmation, so it did not sign you in. ' +
        'Two steps: switch off Authentication → Sign In / Providers → Email → "Confirm email", then run ' +
        'db/confirm-existing-users.sql in the SQL editor to confirm the account that was just created — ' +
        'the setting does not apply retroactively.',
      { code: "confirmation_required" }
    );
  }

  if (displayName) await setDisplayName(displayName);
  return { user: fresh.data.user, created: true };
}

/** A throwaway account for someone who only wants to vote in one session. */
export async function signInAsGuest(displayName) {
  const supabase = await client();
  const existing = await currentUser();
  // Reuse an existing anonymous session — they are already a guest. The name
  // typed for *this* join still applies, though: without it, a second tab's
  // join form would silently keep whatever name the first session used.
  if (existing && isGuest(existing)) {
    if (displayName) await setDisplayName(displayName);
    return existing;
  }
  // If there is a real (non-anonymous) session, sign out first so the guest
  // gets their own identity instead of inheriting the host's account.
  if (existing) await supabase.auth.signOut();
  const { data, error } = await supabase.auth.signInAnonymously({
    options: { data: { display_name: displayName || "Guest", is_anonymous: true } },
  });
  if (error) throw new SupabaseError(describe(error, "Could not start a guest session."), { code: error.code });
  await setDisplayName(displayName);
  return data.user;
}

/* ------------------------------------------------------ password reset ---- */

/**
 * Send a recovery mail. Supabase puts both a link and a six-digit code in it,
 * so the person can use whichever is easier — see the README for the one
 * template change that makes the code visible.
 */
export async function sendPasswordReset(email) {
  const supabase = await client();
  const address = String(email || "").trim().toLowerCase();
  if (!address) throw new SupabaseError("Enter the email address of the account.");
  const { error } = await supabase.auth.resetPasswordForEmail(address, {
    redirectTo: `${location.origin}${location.pathname}#/reset`,
  });
  if (error) throw new SupabaseError(describe(error, "Could not send the reset email."), { code: error.code });
}

/** Exchange the six-digit code for a short-lived session that may set a password. */
export async function verifyRecoveryCode(email, code) {
  const supabase = await client();
  const token = String(code || "").trim().replace(/\s+/g, "");
  if (!token) throw new SupabaseError("Enter the code from the email.");
  const { data, error } = await supabase.auth.verifyOtp({
    email: String(email || "").trim().toLowerCase(),
    token,
    type: "recovery",
  });
  if (error) throw new SupabaseError(describe(error, "That code was not accepted."), { code: error.code });
  return data.user;
}

/** Set a new password. Requires a session — from the code above or the link. */
export async function updatePassword(password) {
  const supabase = await client();
  const secret = String(password || "");
  if (secret.length < 6) throw new SupabaseError("The new password must be at least 6 characters.");
  const { data, error } = await supabase.auth.updateUser({ password: secret });
  if (error) throw new SupabaseError(describe(error, "Could not change the password."), { code: error.code });
  return data.user;
}

/** True once a recovery link or code has produced a session. */
export async function hasRecoverySession() {
  return Boolean(await currentSession());
}

export async function signOut() {
  const supabase = await client();
  await supabase.auth.signOut();
}

export async function setDisplayName(displayName) {
  const name = String(displayName || "").trim();
  if (!name) return;
  const supabase = await client();
  const user = await currentUser();
  if (!user) return;
  await supabase.auth.updateUser({ data: { display_name: name } });
  await supabase.from("pp_profiles").upsert({ id: user.id, display_name: name }, { onConflict: "id" });
}

export async function myProfile() {
  const supabase = await client();
  const user = await currentUser();
  if (!user) return null;
  const { data } = await supabase.from("pp_profiles").select("id, display_name, is_anonymous").eq("id", user.id).maybeSingle();
  return data || { id: user.id, display_name: user.user_metadata?.display_name || "Guest", is_anonymous: isGuest(user) };
}

/* ---------------------------------------------------- project preflight ---- */

/** The project's public auth configuration. */
export async function authSettings() {
  const { url, key } = connection();
  const response = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } });
  if (!response.ok) throw new SupabaseError(`Supabase auth settings unavailable (${response.status}).`);
  return response.json();
}

/**
 * Dashboard switches that have to be right before anyone can sign in or join.
 * Reported up front, because the errors they cause otherwise are misleading —
 * "Confirm email" on shows up as an email rate limit, not as a config problem.
 * @returns {Promise<{title: string, fix: string}[]>}
 */
export async function setupProblems() {
  let settings;
  try {
    settings = await authSettings();
  } catch {
    return [];
  }

  const problems = [];
  if (settings.mailer_autoconfirm === false) {
    problems.push({
      title: "Email confirmation is switched on",
      fix: 'Supabase → Authentication → Sign In / Providers → Email → turn off "Confirm email". Until then, creating an account sends a confirmation mail instead of signing you in, and the free-tier mail limit shows up as "too many attempts".',
    });
  }
  if (settings.disable_signup === true) {
    problems.push({
      title: "New sign-ups are disabled",
      fix: "Supabase → Authentication → Sign In / Providers → Email → allow new users to sign up.",
    });
  }
  // The flag lives at external.anonymous_users, not at the top level.
  if (settings.external?.anonymous_users !== true) {
    problems.push({
      title: "Anonymous sign-in is switched off",
      fix: "Supabase → Authentication → Sign In / Providers → Anonymous → enable. Without it, people opening an invite link cannot join.",
    });
  }
  return problems;
}

/* --------------------------------------------------------------- rooms ---- */

/** Sessions this account owns. RLS means the query cannot return anyone else's. */
export async function myRooms() {
  const supabase = await client();
  const user = await currentUser();
  if (!user) return [];
  return unwrap(
    await supabase
      .from("pp_rooms")
      .select("id, name, invite_token, updated_at, owner_id")
      .eq("owner_id", user.id)
      .order("updated_at", { ascending: false })
      .limit(12),
    "Could not load your sessions."
  );
}

/** Sessions this account was invited to and joined. */
export async function joinedRooms() {
  const supabase = await client();
  const user = await currentUser();
  if (!user) return [];
  const memberships = unwrap(
    await supabase.from("pp_room_members").select("room_id, role, joined_at").eq("user_id", user.id),
    "Could not load your invitations."
  );
  if (!memberships.length) return [];
  const ids = memberships.map((m) => m.room_id);
  const rooms = unwrap(
    await supabase.from("pp_rooms").select("id, name, owner_id, updated_at").in("id", ids),
    "Could not load your invitations."
  );
  const byId = new Map(rooms.map((room) => [room.id, room]));
  return memberships
    .filter((m) => byId.has(m.room_id))
    .map((m) => ({ ...byId.get(m.room_id), role: m.role, joinedAt: m.joined_at }))
    .filter((room) => room.owner_id !== user.id);
}

export async function createRoomRow({ id, name, state }) {
  const supabase = await client();
  const user = await currentUser();
  if (!user) throw new SupabaseError("Sign in before creating a session.");
  const row = unwrap(
    await supabase
      .from("pp_rooms")
      .insert({ id, owner_id: user.id, name, state, version: 1 })
      .select("id, name, invite_token, version, state")
      .single(),
    "Could not create the session."
  );
  // The owner is a participant too.
  await supabase
    .from("pp_room_members")
    .upsert(
      { room_id: id, user_id: user.id, display_name: (await myProfile())?.display_name || "Host", role: "voter" },
      { onConflict: "room_id,user_id" }
    );
  return row;
}

export async function deleteRoom(roomId) {
  const supabase = await client();
  const { error } = await supabase.from("pp_rooms").delete().eq("id", roomId);
  if (error) throw new SupabaseError(describe(error, "Could not delete the session."), { code: error.code });
}

/** Room metadata, or null when this account has no access to it. */
export async function roomMeta(roomId) {
  const supabase = await client();
  const { data, error } = await supabase
    .from("pp_rooms")
    .select("id, name, invite_token, owner_id, version")
    .eq("id", roomId)
    .maybeSingle();
  if (error) throw new SupabaseError(describe(error, "Could not open the session."), { code: error.code });
  return data || null;
}

/* -------------------------------------------------------------- invites --- */

/** What an invited person may see before joining: name, host, how many people. */
export async function previewInvite(token) {
  const supabase = await client();
  const { data, error } = await supabase.rpc("pp_room_preview", { p_invite_token: token });
  if (error) throw new SupabaseError(describe(error, "Could not read that invite."), { code: error.code });
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return null;
  return {
    roomId: row.room_id,
    roomName: row.room_name,
    hostName: row.host_name,
    memberCount: Number(row.member_count) || 0,
  };
}

/** Redeem an invite token. Returns the room id. */
export async function redeemInvite(token, displayName, role) {
  const supabase = await client();
  const { data, error } = await supabase.rpc("pp_join_room", {
    p_invite_token: token,
    p_display_name: displayName,
    p_role: role,
  });
  if (error) throw new SupabaseError(describe(error, "Could not join that session."), { code: error.code });
  return data;
}

export async function leaveRoom(roomId) {
  const supabase = await client();
  const user = await currentUser();
  if (!user) return;
  await supabase.from("pp_room_members").delete().eq("room_id", roomId).eq("user_id", user.id);
}

export async function removeMember(roomId, userId) {
  const supabase = await client();
  const { error } = await supabase.from("pp_room_members").delete().eq("room_id", roomId).eq("user_id", userId);
  if (error) throw new SupabaseError(describe(error, "Could not remove that person."), { code: error.code });
}

export async function touchMembership(roomId, patch) {
  const supabase = await client();
  const user = await currentUser();
  if (!user) return;
  await supabase
    .from("pp_room_members")
    .update({ last_seen: new Date().toISOString(), ...patch })
    .eq("room_id", roomId)
    .eq("user_id", user.id);
}

export function inviteUrl(token) {
  return `${location.origin}${location.pathname}#/join/${token}`;
}
