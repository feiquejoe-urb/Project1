begin;

create table if not exists public.systems (
  id text primary key,
  short_name text not null,
  name text not null,
  color text not null,
  sort_order integer not null unique
);

insert into public.systems (id, short_name, name, color, sort_order) values
  ('system-1', 'System 1', 'Governance & Stakeholder Systems', '#8f3c2d', 1),
  ('system-2', 'System 2', 'Community & Social Systems', '#3974b8', 2),
  ('system-3', 'System 3', 'Economic & Employment Systems', '#a46b16', 3),
  ('system-4', 'System 4', 'Mobility & Accessibility Systems', '#168477', 4),
  ('system-5', 'System 5', 'Environmental & Blue-Green Systems', '#438c52', 5),
  ('system-6', 'System 6', 'Land Use, Urban Structure & Heritage Systems', '#73549b', 6)
on conflict (id) do update set
  short_name = excluded.short_name,
  name = excluded.name,
  color = excluded.color,
  sort_order = excluded.sort_order;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.layers (
  id text primary key,
  system_id text not null references public.systems(id),
  current_dataset_id text,
  name text not null check (char_length(name) between 1 and 160),
  description text not null default '',
  source_note text not null default '',
  processing_note text not null default '',
  created_by uuid not null references auth.users(id) on delete cascade,
  contributor_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'hidden')),
  opacity double precision not null default 0.85 check (opacity between 0 and 1),
  color text not null,
  style_mode text not null default 'single' check (style_mode in ('single', 'categorical', 'graduated')),
  style_field text,
  style_palette text,
  feature_count integer not null default 0 check (feature_count >= 0),
  geometry_types text[] not null default '{}',
  schema_version integer not null default 2
);

create table if not exists public.layer_datasets (
  id text primary key,
  layer_id text not null references public.layers(id) on delete cascade,
  format text not null check (format in ('GeoJSON', 'Shapefile')),
  original_file_name text not null,
  original_object_path text not null unique,
  normalized_object_path text not null unique,
  crs text not null default 'EPSG:4326',
  bbox double precision[],
  feature_count integer not null check (feature_count >= 0),
  geometry_types text[] not null default '{}',
  field_names text[] not null default '{}',
  schema_fingerprint text not null default '',
  processing_status text not null default 'ready' check (processing_status in ('ready', 'failed')),
  processing_error text,
  created_at timestamptz not null default now()
);

do $$ begin
  alter table public.layers
    add constraint layers_current_dataset_id_fkey
    foreign key (current_dataset_id) references public.layer_datasets(id) on delete set null;
exception when duplicate_object then null;
end $$;

create table if not exists public.annotations (
  id text primary key,
  system_id text not null references public.systems(id),
  title text not null check (char_length(title) between 1 and 160),
  note text not null default '',
  longitude double precision not null check (longitude between -180 and 180),
  latitude double precision not null check (latitude between -90 and 90),
  pin_category text not null check (pin_category in ('activity', 'placemaking', 'spatial', 'story', 'documentation', 'issue')),
  attachment_mode text not null default 'none' check (attachment_mode in ('none', 'images', 'pdf')),
  created_by uuid not null references auth.users(id) on delete cascade,
  contributor_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'hidden')),
  schema_version integer not null default 2
);

create table if not exists public.attachments (
  id text primary key,
  annotation_id text not null references public.annotations(id) on delete cascade,
  type text not null check (type in ('image', 'pdf')),
  object_path text not null unique,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size between 0 and 10485760),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.comments (
  id text primary key,
  annotation_id text not null references public.annotations(id) on delete cascade,
  content text not null check (char_length(content) between 1 and 1000),
  created_by uuid not null references auth.users(id) on delete cascade,
  contributor_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists layers_system_idx on public.layers(system_id);
create index if not exists layers_created_idx on public.layers(created_at desc);
create index if not exists datasets_layer_idx on public.layer_datasets(layer_id);
create index if not exists annotations_system_idx on public.annotations(system_id);
create index if not exists annotations_created_idx on public.annotations(created_at desc);
create index if not exists attachments_annotation_idx on public.attachments(annotation_id, sort_order);
create index if not exists comments_annotation_idx on public.comments(annotation_id, created_at);

alter table public.systems enable row level security;
alter table public.profiles enable row level security;
alter table public.layers enable row level security;
alter table public.layer_datasets enable row level security;
alter table public.annotations enable row level security;
alter table public.attachments enable row level security;
alter table public.comments enable row level security;

create policy "authenticated can read systems" on public.systems for select to authenticated using (true);
create policy "authenticated can read profiles" on public.profiles for select to authenticated using (true);
create policy "users create own profile" on public.profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "users update own profile" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "authenticated can read active layers" on public.layers for select to authenticated using (status = 'active' or created_by = (select auth.uid()));
create policy "users create own layers" on public.layers for insert to authenticated with check (created_by = (select auth.uid()));
create policy "users update own layers" on public.layers for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "users delete own layers" on public.layers for delete to authenticated using (created_by = (select auth.uid()));

create policy "authenticated can read active datasets" on public.layer_datasets for select to authenticated using (exists (select 1 from public.layers where layers.id = layer_datasets.layer_id and (layers.status = 'active' or layers.created_by = (select auth.uid()))));
create policy "owners create layer datasets" on public.layer_datasets for insert to authenticated with check (exists (select 1 from public.layers where layers.id = layer_datasets.layer_id and layers.created_by = (select auth.uid())));
create policy "owners update layer datasets" on public.layer_datasets for update to authenticated using (exists (select 1 from public.layers where layers.id = layer_datasets.layer_id and layers.created_by = (select auth.uid()))) with check (exists (select 1 from public.layers where layers.id = layer_datasets.layer_id and layers.created_by = (select auth.uid())));
create policy "owners delete layer datasets" on public.layer_datasets for delete to authenticated using (exists (select 1 from public.layers where layers.id = layer_datasets.layer_id and layers.created_by = (select auth.uid())));

create policy "authenticated can read active annotations" on public.annotations for select to authenticated using (status = 'active' or created_by = (select auth.uid()));
create policy "users create own annotations" on public.annotations for insert to authenticated with check (created_by = (select auth.uid()));
create policy "users update own annotations" on public.annotations for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "users delete own annotations" on public.annotations for delete to authenticated using (created_by = (select auth.uid()));

create policy "authenticated can read active attachments" on public.attachments for select to authenticated using (exists (select 1 from public.annotations where annotations.id = attachments.annotation_id and (annotations.status = 'active' or annotations.created_by = (select auth.uid()))));
create policy "owners create attachments" on public.attachments for insert to authenticated with check (exists (select 1 from public.annotations where annotations.id = attachments.annotation_id and annotations.created_by = (select auth.uid())));
create policy "owners update attachments" on public.attachments for update to authenticated using (exists (select 1 from public.annotations where annotations.id = attachments.annotation_id and annotations.created_by = (select auth.uid()))) with check (exists (select 1 from public.annotations where annotations.id = attachments.annotation_id and annotations.created_by = (select auth.uid())));
create policy "owners delete attachments" on public.attachments for delete to authenticated using (exists (select 1 from public.annotations where annotations.id = attachments.annotation_id and annotations.created_by = (select auth.uid())));

create policy "authenticated can read comments" on public.comments for select to authenticated using (exists (select 1 from public.annotations where annotations.id = comments.annotation_id and annotations.status = 'active'));
create policy "users create own comments" on public.comments for insert to authenticated with check (created_by = (select auth.uid()));
create policy "users update own comments" on public.comments for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));
create policy "users delete own comments" on public.comments for delete to authenticated using (created_by = (select auth.uid()));

grant select on public.systems to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.layers to authenticated;
grant select, insert, update, delete on public.layer_datasets to authenticated;
grant select, insert, update, delete on public.annotations to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;
grant select, insert, update, delete on public.comments to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('spatial-data', 'spatial-data', false, 52428800, array['application/json','application/geo+json','application/zip','application/x-zip-compressed','application/octet-stream']),
  ('observation-images', 'observation-images', false, 10485760, array['image/jpeg','image/png','image/webp']),
  ('observation-documents', 'observation-documents', false, 10485760, array['application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "authenticated read demo files" on storage.objects for select to authenticated using (bucket_id in ('spatial-data', 'observation-images', 'observation-documents'));
create policy "users upload own demo files" on storage.objects for insert to authenticated with check (bucket_id in ('spatial-data', 'observation-images', 'observation-documents') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users update own demo files" on storage.objects for update to authenticated using (bucket_id in ('spatial-data', 'observation-images', 'observation-documents') and owner_id = (select auth.uid())::text) with check ((storage.foldername(name))[1] = (select auth.uid())::text);
create policy "users delete own demo files" on storage.objects for delete to authenticated using (bucket_id in ('spatial-data', 'observation-images', 'observation-documents') and owner_id = (select auth.uid())::text);

create or replace function public.replace_layer_dataset(p_layer_id text, p_new_dataset_id text)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  previous_dataset_id text;
begin
  select current_dataset_id into previous_dataset_id
  from public.layers
  where id = p_layer_id and created_by = auth.uid()
  for update;

  if not found then raise exception 'Layer not found or not owned by current user'; end if;
  if not exists (select 1 from public.layer_datasets where id = p_new_dataset_id and layer_id = p_layer_id) then raise exception 'Replacement dataset does not belong to this layer'; end if;

  update public.layers set current_dataset_id = p_new_dataset_id, updated_at = now() where id = p_layer_id;
  if previous_dataset_id is not null and previous_dataset_id <> p_new_dataset_id then
    delete from public.layer_datasets where id = previous_dataset_id;
  end if;
  return previous_dataset_id;
end;
$$;

grant execute on function public.replace_layer_dataset(text, text) to authenticated;

do $$
declare table_name text;
begin
  foreach table_name in array array['layers','layer_datasets','annotations','attachments','comments'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = table_name) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end $$;

commit;
