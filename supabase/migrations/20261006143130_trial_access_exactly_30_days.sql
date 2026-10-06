create or replace function nfc_private.start_merchant_trial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into nfc_private.merchant_subscriptions(
    owner_id,status,plan,period_ends_at,billing_status,amount_ars,updated_at
  )
  values (
    new.id,'trial','Prueba gratis 30 días · $30.000 ARS/mes',
    timezone('America/Argentina/Cordoba',now())::date + 29,
    'not_configured',30000,now()
  )
  on conflict (owner_id) do nothing;
  return new;
end;
$$;
revoke all on function nfc_private.start_merchant_trial() from public,anon,authenticated;
notify pgrst,'reload schema';