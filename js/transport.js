/**
 * The transport seam — Supabase edition.
 *
 * Room state is one JSONB document in `rooms.state`, guarded by a `version`
 * column. Writers send the version they read; Postgres accepts the write only
 * if nobody else changed the row in between, so two people voting at the same
 * moment can never silently overwrite each other — the loser reloads and
 * replays. Other clients hear about changes over Supabase Realtime.
 *
 * Everything below goes through RLS. A client asking for a room it was not
 * invited to gets nothing back, whatever it sends.
 *
 * Chat rides the same Realtime channel as a broadcast. Broadcasts are relayed
 * between the connected clients and never touch a table, which is the whole
 * point: a message exists only in the browsers that were listening when it was
 * sent. Nothing to store, nothing to delete, nothing to leak later.
 */

import { normalizeRoom } from "./store.js";
import { client } from "./supabase.js";

const CHAT_EVENT = "chat";

export function createSupabaseTransport(roomId) {
  const handlers = new Set();
  const chatHandlers = new Set();
  let channel = null;
  let joining = null;
  let seenVersion = 0;

  function emit(state, version) {
    const room = normalizeRoom(state);
    if (!room) return;
    seenVersion = Math.max(seenVersion, version || 0);
    for (const handler of handlers) handler(room, version || 0);
  }

  return {
    /** @returns {Promise<{state: object, version: number}|null>} */
    async load() {
      const supabase = await client();
      const { data, error } = await supabase
        .from("pp_rooms")
        .select("state, version")
        .eq("id", roomId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const state = normalizeRoom(data.state);
      if (!state) return null;
      seenVersion = Math.max(seenVersion, data.version);
      return { state, version: data.version };
    },

    /**
     * Write state. When `expectedVersion` is given the write is refused unless
     * the row still carries that version.
     * @returns {Promise<{ok: boolean, version?: number, state?: object}>}
     */
    async publish(state, expectedVersion) {
      const supabase = await client();
      let query = supabase
        .from("pp_rooms")
        .update({ state, version: (expectedVersion ?? seenVersion) + 1, name: state.name })
        .eq("id", roomId);
      if (expectedVersion !== undefined && expectedVersion !== null) {
        query = query.eq("version", expectedVersion);
      }
      const { data, error } = await query.select("state, version").maybeSingle();
      if (error) throw error;
      if (!data) return { ok: false }; // somebody else wrote first
      seenVersion = Math.max(seenVersion, data.version);
      return { ok: true, version: data.version, state: normalizeRoom(data.state) };
    },

    onRemote(handler) {
      handlers.add(handler);
      void ensureChannel();
      return () => handlers.delete(handler);
    },

    /** Listen for chat sent by the other clients in this room. */
    onChat(handler) {
      chatHandlers.add(handler);
      void ensureChannel();
      return () => chatHandlers.delete(handler);
    },

    /**
     * Fire a message at whoever is connected right now. Nothing is stored, so
     * there is nothing to catch up on — a client that joins later never sees it.
     * Failure is not worth reporting: a lost chat line is not lost work.
     */
    async sendChat(message) {
      try {
        const ch = await ensureChannel();
        await ch.send({ type: "broadcast", event: CHAT_EVENT, payload: message });
      } catch {
        /* offline, or the channel never came up — the sender still saw it locally */
      }
    },

    close() {
      handlers.clear();
      chatHandlers.clear();
      if (channel) {
        channel.unsubscribe();
        channel = null;
      }
      joining = null;
    },
  };

  function ensureChannel() {
    if (!joining) joining = subscribe();
    return joining;
  }

  async function subscribe() {
    const supabase = await client();
    return new Promise((resolve) => {
      channel = supabase
        .channel(`room:${roomId}`)
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "pp_rooms", filter: `id=eq.${roomId}` },
          (payload) => {
            const row = payload.new;
            if (!row || row.version <= seenVersion) return;
            emit(row.state, row.version);
          }
        )
        .on("broadcast", { event: CHAT_EVENT }, ({ payload }) => {
          if (!payload) return;
          for (const handler of chatHandlers) handler(payload);
        })
        // Settle on any terminal status, never only on success — `sendChat`
        // awaits this, and a promise that can hang forever is a leak.
        .subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            resolve(channel);
          }
        });
    });
  }
}
