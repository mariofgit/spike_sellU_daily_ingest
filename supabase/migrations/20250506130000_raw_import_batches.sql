-- Staging header for raw.raw_leads / raw.raw_lead_activities FK (import_batch_id).
create schema if not exists raw;

create table if not exists raw.import_batches (
  id uuid primary key,
  created_at timestamptz not null default now ()
);

comment on table raw.import_batches is 'Staging import batch UUID; ingest upserts parent row before inserting raw staging rows';
