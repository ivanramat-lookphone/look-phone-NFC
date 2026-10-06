
begin;

alter table nfc_private.merchant_subscriptions
  add column if not exists comped_access boolean not null default false,
  add column if not exists comped_granted_at timestamptz,
  add column if not exists comped_granted_by uuid references auth.users(id),
  add column if not exists comped_revoked_at timestamptz;

alter table nfc_private.merchant_subscriptions
  drop constraint if exists merchant_subscriptions_billing_status_check;
alter table nfc_private.merchant_subscriptions
  add constraint merchant_subscriptions_billing_status_check
  check (billing_status in ('not_configured','pending','authorized','past_due','paused','cancelled','manual_pending','manual_paid','comped'));

create or replace function public.nfc_billing_status()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_user uuid := auth.uid(); v jsonb;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  select jsonb_build_object(
    'merchant_status',coalesce(s.status,'active'),
    'billing_status',coalesce(s.billing_status,'not_configured'),
    'billing_payment_method',s.billing_payment_method,
    'amount_ars',coalesce(s.amount_ars,30000),
    'period_ends_at',s.period_ends_at,
    'checkout_url',case when s.billing_status='pending' then s.checkout_url else null end,
    'provider',s.billing_provider,
    'comped_access',coalesce(s.comped_access,false)
  ) into v from (select 1) q
  left join nfc_private.merchant_subscriptions s on s.owner_id=v_user;
  return v;
end;
$function$;

create or replace function public.nfc_platform_accounts()
returns jsonb language plpgsql stable security definer set search_path to '' as $function$
declare v_user uuid:=auth.uid(); v_accounts jsonb;
begin
  if v_user is null or not exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) then
    raise exception 'Not authorized';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'owner_id',q.owner_id,'email',q.email,'business',q.business,'created_at',q.created_at,
    'status',q.status,'plan',q.plan,'period_ends_at',q.period_ends_at,
    'billing_status',q.billing_status,'billing_payment_method',q.billing_payment_method,
    'amount_ars',q.amount_ars,'last_paid_at',q.last_paid_at,'comped_access',q.comped_access
  ) order by q.created_at desc),'[]'::jsonb) into v_accounts
  from (
    select u.id owner_id,u.email,p.business,u.created_at,
      coalesce(s.status,'active') status,coalesce(s.plan,'Sin asignar') plan,s.period_ends_at,
      coalesce(s.billing_status,'not_configured') billing_status,s.billing_payment_method,
      coalesce(s.amount_ars,30000) amount_ars,s.last_paid_at,coalesce(s.comped_access,false) comped_access
    from auth.users u
    left join public.nfc_profiles p on p.owner_id=u.id
    left join nfc_private.merchant_subscriptions s on s.owner_id=u.id
  ) q;
  return v_accounts;
end;
$function$;

create or replace function public.nfc_platform_gift_access(p_owner uuid,p_enable boolean)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare
  v_user uuid:=auth.uid();
  v_old nfc_private.merchant_subscriptions%rowtype;
  v_restore_active boolean;
begin
  if v_user is null or not exists(select 1 from nfc_private.platform_admins a where a.user_id=v_user) then
    raise exception 'Not authorized';
  end if;
  if p_owner is null or not exists(select 1 from auth.users u where u.id=p_owner) then
    raise exception 'Account not found';
  end if;
  if p_enable is null then raise exception 'Choose whether to grant or revoke access'; end if;

  select * into v_old from nfc_private.merchant_subscriptions where owner_id=p_owner for update;

  if p_enable then
    if found and v_old.comped_access then
      return jsonb_build_object('owner_id',p_owner,'comped_access',true,'status','active');
    end if;
    if found and v_old.billing_status in ('pending','authorized','manual_pending') then
      raise exception 'Cancel or resolve the existing payment method before granting free access';
    end if;
    select coalesce(
      v_old.public_was_active,
      (select bool_or(p.active) from public.nfc_profiles p where p.owner_id=p_owner),
      true
    ) into v_restore_active;
    insert into nfc_private.merchant_subscriptions(
      owner_id,status,plan,period_ends_at,public_was_active,updated_at,
      billing_provider,billing_status,billing_payment_method,mp_preapproval_id,checkout_url,
      comped_access,comped_granted_at,comped_granted_by,comped_revoked_at
    ) values(
      p_owner,'active','Regalo de LOOK Phone · gratuito ilimitado',null,null,now(),
      'comped','comped',null,null,null,true,now(),v_user,null
    )
    on conflict(owner_id) do update set
      status='active',plan='Regalo de LOOK Phone · gratuito ilimitado',
      period_ends_at=null,public_was_active=null,updated_at=now(),
      billing_provider='comped',billing_status='comped',billing_payment_method=null,
      mp_preapproval_id=null,checkout_url=null,comped_access=true,
      comped_granted_at=now(),comped_granted_by=v_user,comped_revoked_at=null;
    update public.nfc_profiles set active=coalesce(v_restore_active,true) where owner_id=p_owner;
    return jsonb_build_object('owner_id',p_owner,'comped_access',true,'status','active');
  end if;

  if not found or not v_old.comped_access then
    return jsonb_build_object('owner_id',p_owner,'comped_access',false,'status',coalesce(v_old.status,'active'));
  end if;
  select coalesce(
    v_old.public_was_active,
    (select bool_or(p.active) from public.nfc_profiles p where p.owner_id=p_owner),
    true
  ) into v_restore_active;
  update nfc_private.merchant_subscriptions set
    status='suspended',plan='Acceso regalado revocado',period_ends_at=null,
    public_was_active=v_restore_active,updated_at=now(),
    billing_provider=null,billing_status='not_configured',billing_payment_method=null,
    mp_preapproval_id=null,checkout_url=null,comped_access=false,comped_revoked_at=now()
  where owner_id=p_owner;
  update public.nfc_profiles set active=false where owner_id=p_owner;
  return jsonb_build_object('owner_id',p_owner,'comped_access',false,'status','suspended');
end;
$function$;

revoke all on function public.nfc_platform_gift_access(uuid,boolean) from public,anon;
grant execute on function public.nfc_platform_gift_access(uuid,boolean) to authenticated;

create or replace function public.nfc_billing_request_manual(p_method text)
returns jsonb language plpgsql security definer set search_path to '' as $function$
declare v_user uuid:=auth.uid(); v_status text; v_end date; v_comped boolean;
begin
  if v_user is null then raise exception 'Authentication required'; end if;
  if p_method not in ('cash','transfer') then raise exception 'Invalid payment method'; end if;
  select status,period_ends_at,comped_access into v_status,v_end,v_comped
    from nfc_private.merchant_subscriptions where owner_id=v_user for update;
  if not found then raise exception 'Billing account not found'; end if;
  if v_comped then raise exception 'This account has free unlimited access'; end if;
  if v_status='active' and (v_end is null or v_end>=current_date)
     and exists(select 1 from nfc_private.merchant_subscriptions where owner_id=v_user and billing_status in ('authorized','manual_paid')) then
    raise exception 'Subscription is already active';
  end if;
  update nfc_private.merchant_subscriptions
     set billing_payment_method=p_method,billing_provider='manual',
         billing_status='manual_pending',updated_at=now()
   where owner_id=v_user;
  return jsonb_build_object('billing_status','manual_pending','billing_payment_method',p_method);
end;
$function$;

create or replace function public.nfc_billing_apply_preapproval(p_owner uuid,p_preapproval_id text,p_mp_status text,p_period_ends_at date)
returns void language plpgsql security definer set search_path to '' as $function$
declare v_old nfc_private.merchant_subscriptions%rowtype;
begin
  if current_setting('request.jwt.claim.role',true) <> 'service_role' then raise exception 'Not authorized'; end if;
  if p_mp_status not in ('authorized','pending','paused','cancelled') then raise exception 'Invalid provider status'; end if;
  select * into v_old from nfc_private.merchant_subscriptions where owner_id=p_owner for update;
  if not found then raise exception 'Account not found'; end if;
  if v_old.comped_access then return; end if;
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
$function$;

commit;
