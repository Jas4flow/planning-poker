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
    // The app sends the full Jira URL after the leading slash
    const url = new URL(req.url);
    const target = url.pathname.replace(/^\/functions\/v1\/jira-proxy\/?/, "");

    if (!target) {
      return new Response(
        JSON.stringify({ error: "Expected a full target URL after the slash." }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Parse the full URL
    let fullUrl: string;
    try {
      // If it looks like a path, prepend https://
      if (target.startsWith("/")) {
        fullUrl = "https://error"; // Will error below
      } else if (target.startsWith("http://") || target.startsWith("https://")) {
        fullUrl = target;
      } else {
        fullUrl = `https://${target}`;
      }
      new URL(fullUrl); // Validate it's a real URL
    } catch {
      return new Response(
        JSON.stringify({ error: "Invalid target URL." }),
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
