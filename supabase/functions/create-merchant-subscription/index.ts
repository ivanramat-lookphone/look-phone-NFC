import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "https://ivanramat-lookphone.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, "Content-Type": "application/json" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const accessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  if (!url || !anonKey || !serviceKey || !accessToken) return json({ error: "La facturación aún no está configurada en el servidor." }, 503);

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "Iniciá sesión para continuar." }, 401);
  const userResponse = await fetch(`${url}/auth/v1/user`, { headers: { apikey: anonKey, Authorization: authorization } });
  if (!userResponse.ok) return json({ error: "La sesión venció. Volvé a iniciar sesión." }, 401);
  const user = await userResponse.json();
  if (!user?.id || !user?.email) return json({ error: "No encontramos el correo de la cuenta." }, 400);

  const current = await fetch(`${url}/rest/v1/rpc/nfc_billing_status`, {
    method: "POST", headers: { apikey: anonKey, Authorization: authorization, "Content-Type": "application/json" }, body: "{}",
  });
  if (!current.ok) return json({ error: "No pudimos consultar el estado de facturación." }, 500);
  const billing = await current.json();
  if (billing?.billing_status === "authorized") return json({ already_active: true, billing_status: "authorized" });
  if (billing?.billing_status === "pending" && typeof billing?.checkout_url === "string") {
    return json({ init_point: billing.checkout_url, billing_status: "pending" });
  }

  const appUrl = "https://ivanramat-lookphone.github.io/look-phone-NFC/";
  const createResponse = await fetch("https://api.mercadopago.com/preapproval", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      reason: "LOOK Phone · Suscripción mensual",
      external_reference: user.id,
      payer_email: user.email,
      back_url: `${appUrl}?billing=return`,
      notification_url: `${url}/functions/v1/mercadopago-webhook`,
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 30000, currency_id: "ARS" },
    }),
  });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !created?.id || !created?.init_point) {
    console.error("Mercado Pago subscription creation failed", createResponse.status, created?.message || created?.error || "unknown");
    return json({ error: "Mercado Pago no pudo crear el enlace de suscripción. Revisá la cuenta e intentá de nuevo." }, 502);
  }

  const store = await fetch(`${url}/rest/v1/rpc/nfc_billing_store_checkout`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_owner: user.id, p_preapproval_id: String(created.id), p_checkout_url: created.init_point }),
  });
  if (!store.ok) {
    console.error("Could not persist subscription checkout", store.status, await store.text());
    return json({ error: "Se creó la solicitud, pero no pudimos guardarla. Contactá soporte antes de volver a intentarlo." }, 500);
  }
  return json({ init_point: created.init_point, billing_status: "pending" });
});
