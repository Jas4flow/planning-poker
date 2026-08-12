import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Get the target URL from the request
    // Can be either: ?url=<encoded-url> (new format) or appended to path (legacy)
    const url = new URL(req.url);
    let target = url.searchParams.get("url");

    if (!target) {
      // Fallback: try to extract from pathname (legacy format)
      target = url.pathname.replace(/^\/functions\/v1\/jira-proxy\/?/, "");
    }

    if (!target) {
      return new Response(
        JSON.stringify({ error: "Expected a target URL in ?url=... or appended to path." }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Parse and validate the target URL
    let fullUrl: string;
    try {
      // Target should be a full URL or a path
      if (target.startsWith("http://") || target.startsWith("https://")) {
        fullUrl = target;
      } else if (target.startsWith("/")) {
        fullUrl = `https://4flow.atlassian.net${target}`;
      } else {
        // Assume it's a path without leading slash
        fullUrl = `https://4flow.atlassian.net/${target}`;
      }
      new URL(fullUrl); // Validate it's a real URL
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid target URL.", detail: target }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Read request body if present
    const method = req.method;
    let body: BodyInit | undefined;
    if (["POST", "PUT", "PATCH"].includes(method)) {
      const text = await req.text();
      if (text) body = text;
    }

    // Forward the request to Jira
    const response = await fetch(fullUrl, {
      method,
      headers: {
        Accept: req.headers.get("accept") || "application/json",
        ...(req.headers.get("authorization")
          ? { Authorization: req.headers.get("authorization")! }
          : {}),
        ...(req.headers.get("content-type")
          ? { "Content-Type": req.headers.get("content-type")! }
          : {}),
      },
      body,
    });

    const responseText = await response.text();
    console.log(`${method} ${fullUrl} → ${response.status}`);

    return new Response(responseText, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error("Proxy error:", error);
    return new Response(
      JSON.stringify({
        error: `Proxy error: ${error instanceof Error ? error.message : String(error)}`,
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      }
    );
  }
});
