import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const allowedOrigins = new Set(["https://lookphone-ar.github.io","https://ivanramat-lookphone.github.io"]);
const corsHeaders = (origin: string | null) => ({
  ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info, prefer",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});
const isoDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const trusted = origin && allowedOrigins.has(origin) ? origin : null;
  const cors = corsHeaders(trusted);
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
  if (origin && !trusted) return json({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const mpToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  if (!url || !anonKey || !serviceKey || !mpToken) return json({ error: "Billing reconciliation unavailable" }, 503);
  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Authentication required" }, 401);
  const authResponse = await fetch(url + "/auth/v1/user", {
    headers: { "apikey": anonKey, "Authorization": authorization },
  });
  if (!authResponse.ok) return json({ error: "Invalid session" }, 401);
  const user = await authResponse.json().catch(() => null);
  if (!user?.id) return json({ error: "Invalid account" }, 401);

  const idResponse = await fetch(url + "/rest/v1/rpc/nfc_billing_my_preapproval_id", {
    method: "POST",
    headers: { "apikey": anonKey, "Authorization": authorization, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!idResponse.ok) return json({ error: "Cannot resolve subscription" }, 502);
  const preapprovalId = await idResponse.json().catch(() => null);
  if (typeof preapprovalId !== "string" || !/^[0-9a-z_-]{8,200}$/i.test(preapprovalId)) {
    return json({ synced: true, subscription: false });
  }

  const api = async (path: string) => {
    const resp = await fetch("https://api.mercadopago.com" + path, {
      headers: { "Authorization": "Bearer " + mpToken },
    });
    if (!resp.ok) throw new Error("Mercado Pago lookup failed (" + resp.status + ")");
    return await resp.json();
  };
  const rpc = async (name: string, data: unknown) => {
    const response = await fetch(url + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: { "apikey": serviceKey, "Authorization": "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error("Billing update failed (" + response.status + ")");
  };

  try {
    const subscription = await api("/preapproval/" + encodeURIComponent(preapprovalId));
    if (String(subscription?.id || "") !== preapprovalId || String(subscription?.external_reference || "") !== user.id) {
      return json({ error: "Subscription/account mismatch" }, 409);
    }
    const rawStatus = String(subscription?.status || "");
    const status = rawStatus === "canceled" ? "cancelled" : rawStatus;
    if (!["authorized", "pending", "paused", "cancelled"].includes(status)) {
      return json({ error: "Unexpected provider state" }, 502);
    }
    const nextPaymentDate = isoDate(subscription?.next_payment_date);
    await rpc("nfc_billing_apply_preapproval", {
      p_owner: user.id,
      p_preapproval_id: preapprovalId,
      p_mp_status: status,
      p_period_ends_at: nextPaymentDate,
    });

    let paymentRecorded = false;
    let paymentLookup = "not_required";
    if (status === "authorized") {
      try {
        const invoices = await api("/authorized_payments/search?preapproval_id=" + encodeURIComponent(preapprovalId));
        const candidates = (Array.isArray(invoices?.results) ? invoices.results : [])
          .filter((item: any) => String(item?.preapproval_id || "") === preapprovalId && item?.payment?.status === "approved"
            && item?.currency_id === "ARS" && Number(item?.transaction_amount) === 30000)
          .sort((a: any, b: any) => Date.parse(b?.debit_date || b?.date_created || "") - Date.parse(a?.debit_date || a?.date_created || ""));
        paymentLookup = "no_approved_invoice";
        for (const invoice of candidates.slice(0, 5)) {
          const paymentId = String(invoice?.payment?.id || "");
          if (!/^[0-9]+$/.test(paymentId)) continue;
          const payment = await api("/v1/payments/" + encodeURIComponent(paymentId));
          if (payment?.status !== "approved" || payment?.currency_id !== "ARS"
            || Number(payment?.transaction_amount) !== 30000 || !payment?.date_approved) continue;
          await rpc("nfc_billing_apply_payment", {
            p_preapproval_id: preapprovalId,
            p_payment_status: "approved",
            p_paid_at: payment.date_approved,
            p_period_ends_at: nextPaymentDate,
          });
          paymentRecorded = true;
          paymentLookup = "approved";
          break;
        }
      } catch (error) {
        paymentLookup = "unavailable";
        console.error("LOOK invoice reconciliation failed", error instanceof Error ? error.message : "unknown");
      }
    }
    return json({ synced: true, subscription: true, status, next_payment_date: nextPaymentDate,
      payment_recorded: paymentRecorded, payment_lookup: paymentLookup });
  } catch (error) {
    console.error("LOOK subscription reconciliation failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Subscription reconciliation temporarily unavailable" }, 502);
  }
});