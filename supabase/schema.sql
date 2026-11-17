-- ArgoStock: server-opslag voor tellingen (Supabase / Postgres).
-- Uitvoeren in het Supabase-dashboard: SQL Editor -> New query -> plakken -> Run.
-- Veilig om opnieuw uit te voeren (idempotent).
--
-- Model: één generieke documenttabel. De app synchroniseert per kantoor zijn eigen records
-- (sessies, invoeren, locatiestatussen, afgeronde resultaten, historiek, ...) als JSON-documenten.
-- Verwijderen gebeurt als "tombstone" (deleted = true), nooit echt.
--
-- BELANGRIJK (tijdelijk, bewuste keuze): er is voorlopig GEEN aanmelding. Wie de app-URL kent, kan lezen en
-- schrijven via de publieke (anon) sleutel. Dit hoort te verdwijnen zodra er aanmelding is (zie docs/SERVER_SYNC.md).

create table if not exists public.sync_docs (
  collection text        not null,
  id         text        not null,
  office_id  text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (collection, id)
);

create index if not exists sync_docs_office_updated_idx on public.sync_docs (office_id, updated_at);

-- updated_at wordt altijd door de server gezet (monotoon, onafhankelijk van de klok van het toestel).
create or replace function public.sync_docs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end $$;

drop trigger if exists sync_docs_touch on public.sync_docs;
create trigger sync_docs_touch
  before insert or update on public.sync_docs
  for each row execute function public.sync_docs_touch();

alter table public.sync_docs enable row level security;

drop policy if exists "sync_docs lezen" on public.sync_docs;
create policy "sync_docs lezen" on public.sync_docs for select to anon using (true);

drop policy if exists "sync_docs toevoegen" on public.sync_docs;
create policy "sync_docs toevoegen" on public.sync_docs for insert to anon with check (true);

drop policy if exists "sync_docs wijzigen" on public.sync_docs;
create policy "sync_docs wijzigen" on public.sync_docs for update to anon using (true) with check (true);

-- Bewust GEEN delete-policy: niets kan echt verwijderd worden via de publieke sleutel.
grant select, insert, update on public.sync_docs to anon;

-- ---------------------------------------------------------------------------------------------------------
-- Centrale bestanden (oude data): de centrale masterdata en historiek per kantoor, zoals ze nu als JSON in
-- central-master-data/ en central-history-data/ staan. De Vercel-functies api/central-master.ts en
-- api/central-history.ts lezen hier vandaan zodra SUPABASE_URL en SUPABASE_ANON_KEY in Vercel staan
-- (anders vallen ze terug op de bestanden). Vullen/verversen met: npm run migrate-central-to-supabase.
-- Schrijven kan enkel met de service-sleutel (geen schrijf-policy voor anon).
-- ---------------------------------------------------------------------------------------------------------
create table if not exists public.central_files (
  kind       text        not null check (kind in ('master', 'history')),
  office_id  text        not null,
  payload    jsonb       not null,
  meta       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (kind, office_id)
);

alter table public.central_files enable row level security;

drop policy if exists "central_files lezen" on public.central_files;
create policy "central_files lezen" on public.central_files for select to anon using (true);

grant select on public.central_files to anon;
