begin;

alter table nfc_private.merchant_subscriptions
  add column if not exists billing_payment_method text;
alter table nfc_private.merchant_subscriptions
  drop constraint if exists merchant_subscriptions_billing_status_check;
alter table nfc_private.merchant_subscriptions
  add constraint merchant_subscriptions_billing_status_check
  check (billing_status in ('not_configured','pending','authorized','past_due','paused','cancelled','manual_pending','manual_paid'));
alter table nfc_private.merchant_subscriptions
  add constraint merchant_subscriptions_payment_method_check
  check (billing_payment_method is null or billing_payment_method in ('mercadopago','cash','transfer'));

create or replace function nfc_private.start_merchant_trial()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into nfc_private.merchant_subscriptions(owner_id,status,plan,period_ends_at,billing_status,amount_ars,updated_at)
  values(new.id,'trial','Prueba gratis 30 días · $30.000 ARS/mes',
    timezone('America/Argentina/Cordoba',now())::date + 30,'not_configured',30000,now())
  on conflict(owner_id) do nothing;
  return new;
end;
$$;
revoke all on function nfc_private.start_merchant_trial() from public,anon,authenticated;
drop trigger if exists nfc_start_merchant_trial on auth.users;
create trigger nfc_start_merchant_trial after insert on auth.users
for each row execute function nfc_private.start_merchant_trial();

create or replace function public.nfc_billing_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select jsonb_build_object('merchant_status',coalesce(s.status,'active'),
    'billing_status',coalesce(s.billing_status,'not_configured'),
    'billing_payment_method',s.billing_payment_method,'amount_ars',coalesce(s.amount_ars,30000),
    'period_ends_at',s.period_ends_at,
    'checkout_url',case when s.billing_status='pending' then s.checkout_url else null end,
    'provider',s.billing_provider)
  into v from (select 1) q left join nfc_private.merchant_subscriptions s on s.owner_id=v_user;
  return v;
end;
$$;

create or replace function public.nfc_billing_request_manual(p_method text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_status text; v_end date;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_method not in ('cash','transfer') then raise exception 'Invalid payment method'; end if;
  select status,period_ends_at into v_status,v_end from nfc_private.merchant_subscriptions where owner_id=v_user for update;
  if not found then raise exception 'Billing account not found'; end if;
  if v_status='active' and (v_end is null or v_end>=current_date)
     and exists(select 1 from nfc_private.merchant_subscriptions where owner_id=v_user and billing_status in ('authorized','manual_paid')) then
    raise exception 'Subscription is already active';
  end if;
  update nfc_private.merchant_subscriptions set billing_payment_method=p_method,billing_provider='manual',
    billing_status='manual_pending',updated_at=now() where owner_id=v_user;
  return jsonb_build_object('billing_status','manual_pending','billing_payment_method',p_method);
end;
$$;

create or replace function public.nfc_platform_confirm_manual_payment(p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_old nfc_private.merchant_subscriptions%rowtype; v_end date;
begin
  if v_user is null or not exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) then raise exception 'Not authorized'; end if;
  select * into v_old from nfc_private.merchant_subscriptions where owner_id=p_owner for update;
  if not found then raise exception 'Account not found'; end if;
  if v_old.billing_status<>'manual_pending' or v_old.billing_payment_method not in ('cash','transfer') then raise exception 'No pending manual payment'; end if;
  v_end:=greatest(coalesce(v_old.period_ends_at,current_date),current_date)+interval '1 month';
  update nfc_private.merchant_subscriptions set status='active',billing_status='manual_paid',billing_provider='manual',
    last_paid_at=now(),period_ends_at=v_end,updated_at=now() where owner_id=p_owner;
  if v_old.status in ('suspended','cancelled') then
    update public.nfc_profiles set active=coalesce(v_old.public_was_active,true) where owner_id=p_owner;
    update nfc_private.merchant_subscriptions set public_was_active=null where owner_id=p_owner;
  end if;
  return jsonb_build_object('status','active','billing_status','manual_paid','period_ends_at',v_end);
end;
$$;

create or replace function public.nfc_platform_accounts()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid:=auth.uid(); v_accounts jsonb;
begin
  if v_user is null or not exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) then raise exception 'Not authorized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('owner_id',q.owner_id,'email',q.email,'business',q.business,
    'created_at',q.created_at,'status',q.status,'plan',q.plan,'period_ends_at',q.period_ends_at,
    'billing_status',q.billing_status,'billing_payment_method',q.billing_payment_method,
    'amount_ars',q.amount_ars,'last_paid_at',q.last_paid_at) order by q.created_at desc),'[]'::jsonb)
  into v_accounts from (
    select u.id owner_id,u.email,p.business,u.created_at,coalesce(s.status,'active') status,
    coalesce(s.plan,'Sin asignar') plan,s.period_ends_at,coalesce(s.billing_status,'not_configured') billing_status,
    s.billing_payment_method,coalesce(s.amount_ars,30000) amount_ars,s.last_paid_at
    from auth.users u left join public.nfc_profiles p on p.owner_id=u.id
    left join nfc_private.merchant_subscriptions s on s.owner_id=u.id
  ) q;
  return v_accounts;
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
  return jsonb_build_object('is_admin',v_admin,'status',v_status,'plan',v_plan,'period_ends_at',v_end,
    'enabled',v_admin or (v_status in ('trial','active') and (v_end is null or v_end>=current_date)));
end;
$$;

revoke all on function public.nfc_billing_request_manual(text) from public,anon;
grant execute on function public.nfc_billing_request_manual(text) to authenticated;
revoke all on function public.nfc_platform_confirm_manual_payment(uuid) from public,anon;
grant execute on function public.nfc_platform_confirm_manual_payment(uuid) to authenticated;
revoke all on function public.nfc_platform_accounts() from public,anon;
grant execute on function public.nfc_platform_accounts() to authenticated;
revoke all on function public.nfc_billing_status() from public,anon;
grant execute on function public.nfc_billing_status() to authenticated;
notify pgrst,'reload schema';
commit;