-- Applied to the hosted project as merchant_launch_branding.
-- Keeps existing merchant data and owner policies.
alter table public.nfc_profiles
  add column if not exists theme_primary text check (theme_primary ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists theme_ink text check (theme_ink ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists theme_soft text check (theme_soft ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists birthday_reward text not null default '15% de descuento por tu cumpleaños'
    check (char_length(birthday_reward) between 1 and 300);
notify pgrst, 'reload schema';
