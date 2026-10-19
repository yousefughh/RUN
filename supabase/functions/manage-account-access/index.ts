import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const allowedOrigin = "https://yousefughh.github.io";
const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const origin = request.headers.get("Origin");
  if (origin && origin !== allowedOrigin) return json({ error: "origin_not_allowed" }, 403);

  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json({ error: "unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    console.error("Missing Supabase function environment configuration.");
    return json({ error: "server_not_configured" }, 500);
  }

  const callerClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: { user: caller }, error: authError } = await callerClient.auth.getUser(token);
  if (authError || !caller) return json({ error: "unauthorized" }, 401);

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: callerProfile, error: callerProfileError } = await adminClient
    .from("profiles").select("role,is_banned").eq("id", caller.id).maybeSingle();
  if (callerProfileError) {
    console.error("Could not verify the requesting account.");
    return json({ error: "requester_check_failed" }, 500);
  }
  if (!callerProfile || callerProfile.role !== "owner" || callerProfile.is_banned) {
    return json({ error: "owner_required" }, 403);
  }

  let body: { user_id?: unknown; blocked?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  const targetId = typeof body.user_id === "string" ? body.user_id : "";
  const blocked = body.blocked;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetId)
      || typeof blocked !== "boolean") {
    return json({ error: "invalid_request" }, 400);
  }
  if (targetId === caller.id) return json({ error: "cannot_block_self" }, 400);

  const { data: target, error: targetError } = await adminClient
    .from("profiles").select("id,role,is_banned").eq("id", targetId).maybeSingle();
  if (targetError) {
    console.error("Could not check the target account.");
    return json({ error: "target_check_failed" }, 500);
  }
  if (!target) return json({ error: "account_not_found" }, 404);
  if (target.role === "owner") return json({ error: "owner_account_protected" }, 403);
  if (target.is_banned === blocked) return json({ ok: true, blocked });

  if (blocked) {
    // The database gate takes effect immediately, including for existing sessions.
    const { error: profileError } = await adminClient.from("profiles")
      .update({ is_banned: true }).eq("id", targetId);
    if (profileError) {
      console.error("Could not apply the account database gate.");
      return json({ error: "account_update_failed" }, 500);
    }

    const { error: authBanError } = await adminClient.auth.admin.updateUserById(
      targetId, { ban_duration: "876000h" },
    );
    if (authBanError) {
      await adminClient.from("profiles").update({ is_banned: false }).eq("id", targetId);
      console.error("Supabase Auth did not accept the account ban.");
      return json({ error: "auth_ban_failed" }, 502);
    }
  } else {
    const { error: authUnbanError } = await adminClient.auth.admin.updateUserById(
      targetId, { ban_duration: "none" },
    );
    if (authUnbanError) {
      console.error("Supabase Auth did not accept the account restore.");
      return json({ error: "auth_restore_failed" }, 502);
    }
    const { error: profileError } = await adminClient.from("profiles")
      .update({ is_banned: false }).eq("id", targetId);
    if (profileError) {
      // Keep this user's sessions blocked if the DB gate could not be lifted.
      await adminClient.auth.admin.updateUserById(targetId, { ban_duration: "876000h" });
      console.error("Could not restore account database access.");
      return json({ error: "account_restore_failed" }, 500);
    }
  }

  return json({ ok: true, blocked });
});
