-- Daily cursor bookkeeping for Sell-U → Supabase (see SELLU_SYNC_STATE_ENABLED).

create table if not exists raw.sellu_sync_state (
  id text primary key default 'default',
  last_synced_local_date date not null,
  updated_at timestamptz not null default now ()
);

grant select, insert, update, delete on table raw.sellu_sync_state to service_role;

comment on table raw.sellu_sync_state is
  'Stores the newest fully-synced calendar day (SELLU_SYNC_TIMEZONE). Next execution advances last_synced_local_date + 1 through yesterday';
