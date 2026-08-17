import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

/**
 * Chat-completion proxy for the app's AI features (estimate suggestions,
 * description summaries, round summaries, disagreement explanations, and the
 * natural-language command bar).
 *
 * The OpenRouter API key is a single shared, server-side secret — it never
 * reaches the browser and the client never sends one. Callers only send the
 * prompt; this forwards it to OpenRouter's OpenAI-compatible endpoint and
 * returns the model's reply.
 *
 * verify_jwt is left at its default (true, see supabase/config.toml) rather
 * than disabled like jira-proxy — jira-proxy forwards each caller's OWN Jira
 * credentials, so there's nothing of this app's to abuse, but this key is
 * shared across every user of the app, so only requests carrying a real
 * Supabase session (host or guest — both are authenticated, just some
 * anonymously) may call it, closing it off to a stranger who finds the URL.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // supabase-js's functions.invoke() attaches its own headers (x-client-info
  // and friends) beyond the ones a plain fetch call sends. Naming them one
  // by one broke as soon as the SDK added another; there's no session
  // cookie here to protect (verify_jwt is what actually gates this
  // function), so a wildcard is both simpler and correct.
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// The `:free` suffix models on OpenRouter are rate-limited (roughly 20
// requests/min and a daily cap on an account with no credit balance) — if
// this starts erroring under real room usage, that is the first thing to
// check before assuming the model itself broke.
const DEFAULT_MODEL = "google/gemma-4-31b-it:free";
// A cost/abuse ceiling — every feature here is a short suggestion or
// summary, none legitimately need a long completion.
const MAX_TOKENS_CAP = 700;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only." }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "AI features are not configured (missing OPENROUTER_API_KEY)." }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  let body: { messages?: unknown; model?: unknown; maxTokens?: unknown };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Expected a JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) {
    return new Response(JSON.stringify({ error: "Expected a non-empty `messages` array." }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
  const requestedTokens = typeof body.maxTokens === "number" ? body.maxTokens : MAX_TOKENS_CAP;
  const maxTokens = Math.max(1, Math.min(requestedTokens, MAX_TOKENS_CAP));

  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        // Not required for the request to work, but OpenRouter asks for
        // these to attribute usage to the calling app.
        "HTTP-Referer": "https://jas4flow.github.io/planning-poker/",
        "X-Title": "Planning Poker",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4, stream: false }),
    });

    const text = await response.text();
    if (!response.ok) {
      console.error(`OpenRouter API ${response.status}:`, text);
      return new Response(JSON.stringify({ error: `The AI service returned an error (${response.status}).` }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    let payload: { choices?: { message?: { content?: string } }[] };
    try {
      payload = JSON.parse(text);
    } catch {
      return new Response(JSON.stringify({ error: "The AI service returned an unreadable response." }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const reply = payload?.choices?.[0]?.message?.content?.trim() || "";
    return new Response(JSON.stringify({ text: reply }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error) {
    console.error("ai-proxy error:", error);
    return new Response(
      JSON.stringify({ error: `Could not reach the AI service: ${error instanceof Error ? error.message : String(error)}` }),
      { status: 502, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
