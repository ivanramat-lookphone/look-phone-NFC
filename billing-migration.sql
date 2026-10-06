-- LOOK Phone recurring merchant billing. Mercado Pago approval is always initiated by the merchant.
begin;

alter table nfc_private.merchant_subscriptions
  drop constraint if exists merchant_subscriptions_status_check;
alter table nfc_private.merchant_subscriptions
  add constraint merchant_subscriptions_status_check
  check (status in ('trial','active','suspended','cancelled'));

alter table nfc_private.merchant_subscriptions
  add column if not exists billing_provider text,
  add column if not exists billing_status text not null default 'not_configured',
  add column if not exists mp_preapproval_id text,
  add column if not exists checkout_url text,
  add column if not exists amount_ars integer not null default 30000,
  add column if not exists last_paid_at timestamptz;

alter table nfc_private.merchant_subscriptions
  add constraint merchant_subscriptions_billing_status_check
  check (billing_status in ('not_configured','pending','authorized','past_due','paused','cancelled'));
create unique index if not exists merchant_subscriptions_mp_preapproval_id_key
  on nfc_private.merchant_subscriptions(mp_preapproval_id)
  where mp_preapproval_id is not null;
alter table nfc_private.merchant_subscriptions enable row level security;
revoke all on nfc_private.merchant_subscriptions from anon, authenticated, public;

create or replace function public.nfc_billing_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select jsonb_build_object(
    'billing_status',coalesce(s.billing_status,'not_configured'),
    'amount_ars',coalesce(s.amount_ars,30000),
    'period_ends_at',s.period_ends_at,
    'checkout_url',case when s.billing_status='pending' then s.checkout_url else null end,
    'provider',s.billing_provider
  ) into v from (select 1) q
  left join nfc_private.merchant_subscriptions s on s.owner_id=v_user;
  return v;
end;
$$;

create or replace function public.nfc_billing_store_checkout(
  p_owner uuid, p_preapproval_id text, p_checkout_url text
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('request.jwt.claim.role',true) <> 'service_role' then raise exception 'Not authorized'; end if;
  if p_owner is null or not exists(select 1 from auth.users where id=p_owner) then raise exception 'Account not found'; end if;
  if coalesce(length(p_preapproval_id),0)<1 or coalesce(length(p_preapproval_id),0)>200 then raise exception 'Invalid subscription id'; end if;
  if p_checkout_url !~ '^https://www\.mercadopago\.com(\.ar)?/' then raise exception 'Invalid checkout URL'; end if;
  insert into nfc_private.merchant_subscriptions(owner_id,status,plan,billing_provider,billing_status,mp_preapproval_id,checkout_url,amount_ars,updated_at)
  values(p_owner,'active','Mensual · $30.000 ARS','mercadopago','pending',p_preapproval_id,p_checkout_url,30000,now())
  on conflict(owner_id) do update set
    billing_provider='mercadopago',billing_status='pending',mp_preapproval_id=excluded.mp_preapproval_id,
    checkout_url=excluded.checkout_url,amount_ars=30000,plan='Mensual · $30.000 ARS',updated_at=now();
end;
$$;

create or replace function public.nfc_billing_apply_preapproval(
  p_owner uuid, p_preapproval_id text, p_mp_status text, p_period_ends_at date
) returns void language plpgsql security definer set search_path = '' as $$
declare v_old nfc_private.merchant_subscriptions%rowtype;
begin
  if current_setting('request.jwt.claim.role',true) <> 'service_role' then raise exception 'Not authorized'; end if;
  if p_mp_status not in ('authorized','pending','paused','cancelled') then raise exception 'Invalid provider status'; end if;
  select * into v_old from nfc_private.merchant_subscriptions where owner_id=p_owner for update;
  if not found then raise exception 'Account not found'; end if;
  if v_old.mp_preapproval_id is not null and v_old.mp_preapproval_id<>p_preapproval_id then raise exception 'Subscription mismatch'; end if;
  update nfc_private.merchant_subscriptions set
    mp_preapproval_id=p_preapproval_id,billing_provider='mercadopago',billing_status=p_mp_status,
    period_ends_at=coalesce(p_period_ends_at,period_ends_at),
    status=case
      when p_mp_status='authorized' then 'active'
      when p_mp_status='paused' and (p_period_ends_at is null or p_period_ends_at<current_date) then 'suspended'
      when p_mp_status='cancelled' and (p_period_ends_at is null or p_period_ends_at<current_date) then 'cancelled'
      when status in ('trial','active') then status
      else status end,
    updated_at=now()
  where owner_id=p_owner;
  if p_mp_status='authorized' and v_old.status in ('suspended','cancelled') then
    update public.nfc_profiles set active=coalesce(v_old.public_was_active,true) where owner_id=p_owner;
    update nfc_private.merchant_subscriptions set public_was_active=null where owner_id=p_owner;
  elsif p_mp_status in ('paused','cancelled') and (p_period_ends_at is null or p_period_ends_at<current_date)
        and v_old.status in ('trial','active') then
    update nfc_private.merchant_subscriptions set public_was_active=(select bool_or(active) from public.nfc_profiles where owner_id=p_owner) where owner_id=p_owner;
    update public.nfc_profiles set active=false where owner_id=p_owner;
  end if;
end;
$$;

create or replace function public.nfc_billing_apply_payment(
  p_preapproval_id text, p_payment_status text, p_paid_at timestamptz, p_period_ends_at date
) returns void language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_old nfc_private.merchant_subscriptions%rowtype;
begin
  if current_setting('request.jwt.claim.role',true) <> 'service_role' then raise exception 'Not authorized'; end if;
  select owner_id into v_owner from nfc_private.merchant_subscriptions where mp_preapproval_id=p_preapproval_id for update;
  if v_owner is null then return; end if;
  select * into v_old from nfc_private.merchant_subscriptions where owner_id=v_owner;
  if p_payment_status='approved' then
    update nfc_private.merchant_subscriptions set billing_status='authorized',status='active',
      last_paid_at=coalesce(p_paid_at,now()),period_ends_at=coalesce(p_period_ends_at,period_ends_at),updated_at=now()
      where owner_id=v_owner;
    if v_old.status in ('suspended','cancelled') then
      update public.nfc_profiles set active=coalesce(v_old.public_was_active,true) where owner_id=v_owner;
      update nfc_private.merchant_subscriptions set public_was_active=null where owner_id=v_owner;
    end if;
  elsif p_payment_status in ('rejected','cancelled','refunded','charged_back') then
    update nfc_private.merchant_subscriptions set billing_status='past_due',updated_at=now()
      where owner_id=v_owner;
    if (coalesce(p_period_ends_at,v_old.period_ends_at) is null or coalesce(p_period_ends_at,v_old.period_ends_at)<current_date)
       and v_old.status in ('trial','active') then
      update nfc_private.merchant_subscriptions set public_was_active=(select bool_or(active) from public.nfc_profiles where owner_id=v_owner),status='suspended'
        where owner_id=v_owner;
      update public.nfc_profiles set active=false where owner_id=v_owner;
    end if;
  end if;
end;
$$;

create or replace function public.nfc_platform_access_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_admin boolean; v_status text; v_plan text; v_end date;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) into v_admin;
  select s.status,s.plan,s.period_ends_at into v_status,v_plan,v_end from nfc_private.merchant_subscriptions s where s.owner_id=v_user;
  v_status:=coalesce(v_status,'active'); v_plan:=coalesce(v_plan,'Sin asignar');
  return jsonb_build_object('is_admin',v_admin,'status',v_status,'plan',v_plan,
    'enabled',v_status in ('trial','active') and (v_end is null or v_end>=current_date));
end;
$$;

create or replace function nfc_private.current_account_enabled()
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and coalesce(
    (select s.status in ('trial','active') and (s.period_ends_at is null or s.period_ends_at>=current_date)
       from nfc_private.merchant_subscriptions s where s.owner_id=auth.uid()), true);
$$;

revoke all on function public.nfc_billing_status() from public,anon;
revoke all on function public.nfc_billing_store_checkout(uuid,text,text) from public,anon,authenticated;
revoke all on function public.nfc_billing_apply_preapproval(uuid,text,text,date) from public,anon,authenticated;
revoke all on function public.nfc_billing_apply_payment(text,text,timestamptz,date) from public,anon,authenticated;
grant execute on function public.nfc_billing_status() to authenticated;
grant execute on function public.nfc_billing_store_checkout(uuid,text,text) to service_role;
grant execute on function public.nfc_billing_apply_preapproval(uuid,text,text,date) to service_role;
grant execute on function public.nfc_billing_apply_payment(text,text,timestamptz,date) to service_role;
grant execute on function nfc_private.current_account_enabled() to authenticated;

create or replace function public.nfc_platform_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_accounts jsonb;
begin
  if v_user is null or not exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) then raise exception 'Not authorized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'owner_id',q.owner_id,'email',q.email,'business',q.business,'created_at',q.created_at,
    'status',q.status,'plan',q.plan,'period_ends_at',q.period_ends_at,
    'billing_status',q.billing_status,'amount_ars',q.amount_ars,'last_paid_at',q.last_paid_at
  ) order by q.created_at desc),'[]'::jsonb) into v_accounts
  from (select u.id owner_id,u.email,p.business,u.created_at,coalesce(s.status,'active') status,
    coalesce(s.plan,'Sin asignar') plan,s.period_ends_at,coalesce(s.billing_status,'not_configured') billing_status,
    coalesce(s.amount_ars,30000) amount_ars,s.last_paid_at
    from auth.users u left join public.nfc_profiles p on p.owner_id=u.id
    left join nfc_private.merchant_subscriptions s on s.owner_id=u.id) q;
  return v_accounts;
end;
$$;
revoke all on function public.nfc_platform_access_status() from public,anon;
grant execute on function public.nfc_platform_access_status() to authenticated;
revoke all on function public.nfc_platform_accounts() from public,anon;
grant execute on function public.nfc_platform_accounts() to authenticated;
notify pgrst,'reload schema';
commit;
