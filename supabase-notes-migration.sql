-- Ejecutar una sola vez en el SQL Editor de Supabase antes de usar Notas.
-- Es compatible con registros actuales y no modifica ni elimina datos existentes.
alter table public.nfc_clients
  add column if not exists notes text null
  check (notes is null or char_length(notes) <= 1000);

notify pgrst, 'reload schema';
