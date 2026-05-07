-- Spike: receptáculo para datos sincronizados desde Sell-U (CRM).
-- Ajusta columnas cuando tengas el contrato real del API.

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid (),
  sellu_id text not null,
  email text,
  full_name text,
  company text,
  status text,
  metadata jsonb not null default '{}',
  raw jsonb,
  synced_at timestamptz not null default now (),
  created_at timestamptz not null default now (),
  updated_at timestamptz not null default now (),
  constraint leads_sellu_id_key unique (sellu_id)
);

create index if not exists leads_email_idx on public.leads (email);
create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_synced_at_idx on public.leads (synced_at desc);

create table if not exists public.leads_activity (
  id uuid primary key default gen_random_uuid (),
  lead_id uuid not null references public.leads (id) on delete cascade,
  sellu_activity_id text not null,
  activity_type text,
  subject text,
  body text,
  occurred_at timestamptz,
  metadata jsonb not null default '{}',
  raw jsonb,
  synced_at timestamptz not null default now (),
  constraint leads_activity_sellu_uid unique (sellu_activity_id)
);

create index if not exists leads_activity_lead_id_idx on public.leads_activity (lead_id);
create index if not exists leads_activity_occurred_at_idx on public.leads_activity (occurred_at desc);

create or replace function public.leads_set_updated_at ()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now ();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row
  execute function public.leads_set_updated_at ();

alter table public.leads enable row level security;
alter table public.leads_activity enable row level security;

-- Ajusta políticas según tu producto (solo servicio con service_role suele bastar para ETL).
-- La clave service_role en PostgREST ignora RLS; anon/authenticated quedan sin acceso por defecto.

comment on table public.leads is 'Leads importados desde Sell-U (CRM).';
comment on table public.leads_activity is 'Actividades de lead importadas desde Sell-U.';
