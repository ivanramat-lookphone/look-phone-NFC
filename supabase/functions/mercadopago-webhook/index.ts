import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
const hmacHex = async (secret: string, message: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, "0")).join("");
};
const secureEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
};
const isoDate = (value: unknown): string | null => typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const mpToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  const webhookSecret = Deno.env.get("MERCADOPAGO_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceKey || !mpToken || !webhookSecret) return json({ error: "Webhook is not configured" }, 503);

  const url = new URL(req.url);
  const payload = await req.json().catch(() => ({}));
  const dataId = String(url.searchParams.get("data.id") || payload?.data?.id || "").toLowerCase();
  const type = String(payload?.type || payload?.topic || url.searchParams.get("type") || "");
  if (!dataId || !/^[a-z0-9_-]{1,200}$/.test(dataId)) return json({ error: "Missing notification id" }, 400);

  const signature = req.headers.get("x-signature") || "";
  const requestId = req.headers.get("x-request-id");
  const parts = Object.fromEntries(signature.split(",").map(part => part.trim().split("=", 2) as [string, string]));
  if (!parts.ts || !parts.v1) return json({ error: "Missing signature" }, 401);
  const manifest = `id:${dataId};${requestId ? `request-id:${requestId};` : ""}ts:${parts.ts};`;
  const expected = await hmacHex(webhookSecret, manifest);
  if (!secureEqual(expected, parts.v1.toLowerCase())) return json({ error: "Invalid signature" }, 401);

  const api = async (path: string) => {
    const response = await fetch(`https://api.mercadopago.com${path}`, { headers: { Authorization: `Bearer ${mpToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Mercado Pago lookup failed (${response.status})`);
    return data;
  };
  const rpc = async (name: string, body: unknown) => {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Subscription update failed (${response.status}): ${await response.text()}`);
  };

  const recordApprovedInvoice = async (invoice: any, subscription: any) => {
    if (String(subscription?.status || "") !== "authorized") return false;
    if (String(invoice?.preapproval_id || "") !== String(subscription?.id || "")) return false;
    if (invoice?.currency_id !== "ARS" || Number(invoice?.transaction_amount) !== 30000) return false;
    if (String(invoice?.payment?.status || "") !== "approved") return false;
    const paymentId = String(invoice?.payment?.id || "");
    if (!/^[0-9]+$/.test(paymentId)) return false;
    const payment = await api("/v1/payments/" + encodeURIComponent(paymentId));
    if (payment?.status !== "approved" || payment?.currency_id !== "ARS"
      || Number(payment?.transaction_amount) !== 30000 || !payment?.date_approved) return false;
    await rpc("nfc_billing_apply_payment", {
      p_preapproval_id: String(subscription.id),
      p_payment_status: "approved",
      p_paid_at: payment.date_approved,
      p_period_ends_at: isoDate(subscription?.next_payment_date),
    });
    await rpc("nfc_billing_record_verified_event", {
      p_preapproval_id: String(subscription.id),
      p_payment_id: paymentId,
      p_status: "approved",
      p_amount_ars: 30000,
      p_event_at: payment.date_approved,
      p_period_ends_at: isoDate(subscription?.next_payment_date),
    });
    return true;
  };

  const recordFailedInvoice = async (invoice: any, subscription: any) => {
    if (String(subscription?.status || "") !== "authorized") return false;
    if (String(invoice?.preapproval_id || "") !== String(subscription?.id || "")) return false;
    if (invoice?.currency_id !== "ARS" || Number(invoice?.transaction_amount) !== 30000) return false;
    const paymentId = String(invoice?.payment?.id || "");
    if (!/^[0-9]+$/.test(paymentId)) return false;
    const rejected = new Set(["rejected", "cancelled", "refunded", "charged_back"]);
    if (!rejected.has(String(invoice?.payment?.status || ""))) return false;
    const payment = await api("/v1/payments/" + encodeURIComponent(paymentId));
    const paymentStatus = String(payment?.status || "");
    if (!rejected.has(paymentStatus) || payment?.currency_id !== "ARS"
      || Number(payment?.transaction_amount) !== 30000) return false;
    const eventDate = payment?.date_last_updated || payment?.date_created;
    if (!eventDate) return false;
    await rpc("nfc_billing_apply_failed_payment", {
      p_preapproval_id: String(subscription.id),
      p_payment_status: paymentStatus,
      p_failed_at: eventDate,
    });
    await rpc("nfc_billing_record_verified_event", {
      p_preapproval_id: String(subscription.id),
      p_payment_id: paymentId,
      p_status: paymentStatus,
      p_amount_ars: 30000,
      p_event_at: eventDate,
      p_period_ends_at: isoDate(subscription?.next_payment_date),
    });
    return true;
  };

  const recoverLatestPayment = async (subscription: any) => {
    if (String(subscription?.status || "") !== "authorized") return false;
    const search = await api("/authorized_payments/search?preapproval_id=" + encodeURIComponent(String(subscription.id)));
    const invoices = (Array.isArray(search?.results) ? search.results : [])
      .filter((item: any) => String(item?.preapproval_id || "") === String(subscription.id)
        && item?.payment?.status === "approved")
      .sort((a: any, b: any) => Date.parse(b?.debit_date || b?.date_created || "") - Date.parse(a?.debit_date || a?.date_created || ""));
    for (const invoice of invoices.slice(0, 5)) {
      if (await recordApprovedInvoice(invoice, subscription)) return true;
    }
    return false;
  };

  try {
    if (type === "subscription_preapproval") {
      const subscription = await api(`/preapproval/${encodeURIComponent(dataId)}`);
      const ownerId = String(subscription?.external_reference || "");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ownerId)) return json({ error: "Invalid account reference" }, 400);
      const status = String(subscription?.status || "");
      const safeStatus = status === "canceled" ? "cancelled" : ["authorized", "pending", "paused", "cancelled"].includes(status) ? status : "pending";
      await rpc("nfc_billing_apply_preapproval", {
        p_owner: ownerId,
        p_preapproval_id: String(subscription.id),
        p_mp_status: safeStatus,
        p_period_ends_at: isoDate(subscription?.next_payment_date),
      });
      if (safeStatus === "authorized") {
        try { await recoverLatestPayment(subscription); }
        catch (error) { console.error("Mercado Pago invoice recovery failed", error instanceof Error ? error.message : "unknown"); }
      }
      return json({ received: true });
    }

    if (type === "subscription_authorized_payment") {
      const invoice = await api("/authorized_payments/" + encodeURIComponent(dataId));
      const preapprovalId = String(invoice?.preapproval_id || "");
      if (!preapprovalId) return json({ received: true, ignored: true });
      const subscription = await api("/preapproval/" + encodeURIComponent(preapprovalId));
      const recorded = await recordApprovedInvoice(invoice, subscription);
      const declined = !recorded && await recordFailedInvoice(invoice, subscription);
      return json({ received: true, recorded, declined });
    }
    return json({ received: true, ignored: true });
  } catch (error) {
    console.error("Mercado Pago webhook processing failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Temporary processing failure" }, 500);
  }
});
