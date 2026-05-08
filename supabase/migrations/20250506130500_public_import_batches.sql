-- When raw.raw_leads FK targets public.import_batches (common), parent rows belong here too.
create table if not exists public.import_batches (
  id uuid primary key,
  created_at timestamptz not null default now ()
);

comment on table public.import_batches is 'Batch header for raw.raw_leads.import_batch_id when FK references public';
