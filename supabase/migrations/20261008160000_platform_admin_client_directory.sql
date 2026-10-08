create or replace function public.nfc_platform_client_directory(
  p_search text default '',
  p_limit integer default 100,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_user uuid := auth.uid();
  v_search text := lower(btrim(coalesce(p_search, '')));
  v_total bigint;
  v_rows jsonb;
begin
  if v_user is null or not exists (
    select 1
    from nfc_private.platform_admins a
    where a.user_id = v_user
  ) then
    raise exception 'Not authorized';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Invalid page size';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'Invalid page offset';
  end if;

  select count(*) into v_total
  from public.nfc_clients c
  join public.nfc_profiles p on p.id = c.profile_id
  left join auth.users u on u.id = p.owner_id
  where v_search = ''
     or lower(coalesce(c.name, '') || ' ' || coalesce(c.phone, '') ||
              ' ' || coalesce(p.business, '') || ' ' || coalesce(u.email, ''))
        like '%' || v_search || '%';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'business', q.business,
        'merchant_email', q.merchant_email,
        'client_name', q.client_name,
        'client_phone', q.client_phone,
        'points', q.points,
        'visits', q.visits,
        'category', q.category,
        'created_at', q.created_at
      ) order by q.created_at desc, q.business, q.client_name
    ),
    '[]'::jsonb
  ) into v_rows
  from (
    select p.business,
           u.email as merchant_email,
           c.name as client_name,
           c.phone as client_phone,
           c.points,
           c.visits,
           coalesce(c.manual_category, 'sin categoría') as category,
           c.created_at
    from public.nfc_clients c
    join public.nfc_profiles p on p.id = c.profile_id
    left join auth.users u on u.id = p.owner_id
    where v_search = ''
       or lower(coalesce(c.name, '') || ' ' || coalesce(c.phone, '') ||
                ' ' || coalesce(p.business, '') || ' ' || coalesce(u.email, ''))
          like '%' || v_search || '%'
    order by c.created_at desc, p.business, c.name
    limit p_limit offset p_offset
  ) q;

  return jsonb_build_object(
    'total', v_total,
    'limit', p_limit,
    'offset', p_offset,
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.nfc_platform_client_directory(text, integer, integer) from public, anon;
grant execute on function public.nfc_platform_client_directory(text, integer, integer) to authenticated;
