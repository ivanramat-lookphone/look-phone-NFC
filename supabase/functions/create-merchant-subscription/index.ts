import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const allowedAppOrigins = new Set([
  "https://ivanramat-lookphone.github.io",
  "https://lookphone-ar.github.io",
]);
const corsHeaders = (origin: string | null) => ({
  ...(origin && allowedAppOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, prefer",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  const trustedOrigin = origin && allowedAppOrigins.has(origin) ? origin : null;
  const cors = corsHeaders(trustedOrigin);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
  if (origin && !trustedOrigin) return json({ error: "Origin not allowed." }, 403);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const accessToken = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
  const testPayerEmail = Deno.env.get("MERCADOPAGO_TEST_PAYER_EMAIL");
  const isTestMode = Deno.env.get("MERCADOPAGO_TEST_MODE") === "true";
  if (!url || !anonKey || !serviceKey || !accessToken) return json({ error: "La facturación aún no está configurada en el servidor." }, 503);
  if (isTestMode && !testPayerEmail) return json({ error: "Falta configurar el correo del comprador de prueba de Mercado Pago en el servidor." }, 503);

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
  if (billing?.comped_access) return json({ already_active: true, comped_access: true });
  const argentinaToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Cordoba", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  if (billing?.merchant_status === "trial" && billing?.period_ends_at >= argentinaToday) {
    return json({ error: `Tu prueba gratuita termina el ${billing.period_ends_at}. Podrás elegir cómo pagar a partir de esa fecha.` }, 409);
  }
  if (billing?.billing_status === "authorized") return json({ already_active: true, billing_status: "authorized" });
  if (billing?.billing_status === "pending" && typeof billing?.checkout_url === "string") {
    return json({ init_point: billing.checkout_url, billing_status: "pending" });
  }

  if (isTestMode) {
    const profileResponse = await fetch("https://api.mercadopago.com/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const profile = await profileResponse.json().catch(() => ({}));
    console.log("Mercado Pago test credential check", JSON.stringify({
      profileStatus: profileResponse.status,
      profileId: profile?.id,
      siteId: profile?.site_id,
      tokenType: accessToken.startsWith("TEST-") ? "TEST" : accessToken.startsWith("APP_USR-") ? "APP_USR" : "other",
      payerEmailMatchesBuyer: (testPayerEmail || "").trim().toLowerCase() === "test_user_5539609640704451681@testuser.com",
    }));
  }

  const appUrl = `${trustedOrigin || "https://ivanramat-lookphone.github.io"}/look-phone-NFC/`;
  const createResponse = await fetch("https://api.mercadopago.com/preapproval", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({
      reason: "LOOK - Suscripción mensual",
      external_reference: user.id,
      payer_email: isTestMode ? testPayerEmail : user.email,
      back_url: `${appUrl}?billing=return`,
      auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: 30000, currency_id: "ARS", ...(isTestMode ? { end_date: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString() } : {}) },
      status: "pending",
    }),
  });
  const created = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !created?.id || !created?.init_point) {
    console.error("Mercado Pago subscription creation failed", JSON.stringify({ status: createResponse.status, error: created?.error, message: created?.message, cause: created?.cause, details: created?.details, errors: created?.errors, responseKeys: Object.keys(created || {}), requestId: createResponse.headers.get("x-request-id"), testMode: isTestMode, testPayerEmailConfigured: Boolean(testPayerEmail) }));
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
