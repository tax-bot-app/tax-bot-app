-- Stripe Webhookを「受信済み」ではなく「正常処理済み」で冪等管理する。
-- 既存行は過去に200を返したイベントなので processed として移行する。

alter table public.stripe_webhook_events
  add column if not exists status text,
  add column if not exists processing_token text,
  add column if not exists last_error text,
  add column if not exists processed_at timestamptz,
  add column if not exists updated_at timestamptz;

update public.stripe_webhook_events
set
  status = 'processed',
  processing_token = null,
  processed_at = now(),
  updated_at = coalesce(updated_at, now())
where status is null;

update public.stripe_webhook_events
set updated_at = now()
where updated_at is null;

alter table public.stripe_webhook_events
  alter column status set default 'processing',
  alter column status set not null,
  alter column updated_at set default now(),
  alter column updated_at set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stripe_webhook_events_status_check'
      and conrelid = 'public.stripe_webhook_events'::regclass
  ) then
    alter table public.stripe_webhook_events
      add constraint stripe_webhook_events_status_check
      check (status in ('processing', 'processed', 'failed'));
  end if;
end
$$;

create index if not exists stripe_webhook_events_status_updated_idx
  on public.stripe_webhook_events (status, updated_at);
