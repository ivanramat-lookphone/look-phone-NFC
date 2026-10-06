create or replace function public.nfc_billing_store_checkout(
  p_owner uuid,p_preapproval_id text,p_checkout_url text
) returns void language plpgsql security definer set search_path='' as $$
begin
  if current_setting('request.jwt.claim.role',true)<>'service_role' then raise exception 'Not authorized'; end if;
  if p_owner is null or not exists(select 1 from auth.users where id=p_owner) then raise exception 'Account not found'; end if;
  if coalesce(length(p_preapproval_id),0)<1 or coalesce(length(p_preapproval_id),0)>200 then raise exception 'Invalid subscription id'; end if;
  if p_checkout_url !~ '^https://www\.mercadopago\.com(\.ar)?/' then raise exception 'Invalid checkout URL'; end if;
  insert into nfc_private.merchant_subscriptions(owner_id,status,plan,billing_provider,billing_status,billing_payment_method,mp_preapproval_id,checkout_url,amount_ars,updated_at)
  values(p_owner,'active','Mensual · $30.000 ARS','mercadopago','pending','mercadopago',p_preapproval_id,p_checkout_url,30000,now())
  on conflict(owner_id) do update set billing_provider='mercadopago',billing_status='pending',billing_payment_method='mercadopago',
    mp_preapproval_id=excluded.mp_preapproval_id,checkout_url=excluded.checkout_url,amount_ars=30000,
    plan='Mensual · $30.000 ARS',updated_at=now();
end;
$$;
revoke all on function public.nfc_billing_store_checkout(uuid,text,text) from public,anon,authenticated;
grant execute on function public.nfc_billing_store_checkout(uuid,text,text) to service_role;
notify pgrst,'reload schema';