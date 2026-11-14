-- Smart Rehabilitation Glove - Supabase schema (already applied to the
-- "smart-rehab-glove" project). Keep for reference or to rebuild the DB.
-- Public app (no login): anyone may read, and add patients / sessions /
-- results. Tutorials are read-only for the public.

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  injured_hand text not null default 'right' check (injured_hand in ('left','right')),
  notes text,
  created_at timestamptz not null default now()
);

create table public.tutorials (
  id bigint generated always as identity primary key,
  title text not null,
  exercise_type text not null check (exercise_type in ('flex','thumb','general')),
  level text not null check (level in ('beginner','intermediate','advanced')),
  duration_min int not null default 5,
  description text not null,
  steps text[] not null default '{}',
  tips text,
  video_url text,
  sort_order int not null default 0
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  exercise_type text not null check (exercise_type in ('flex','thumb')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  target_percent int,
  reps_count int not null default 0,
  avg_peak_percent numeric(5,1),
  best_peak_percent int,
  avg_smoothness numeric(5,3),
  good_rep_ratio numeric(4,3),
  trials_count int,
  success_rate numeric(4,3),
  avg_reaction_ms int
);
create index sessions_patient_id_idx on public.sessions (patient_id, started_at desc);

create table public.repetitions (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  rep_index int not null,
  peak_percent int not null,
  duration_ms int not null,
  time_to_peak_ms int,
  hold_ms int,
  smoothness numeric(5,3),
  tremor numeric(6,3),
  quality text not null,
  confidence numeric(4,3),
  created_at timestamptz not null default now()
);
create index repetitions_session_id_idx on public.repetitions (session_id);

create table public.touch_trials (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  trial_index int not null,
  success boolean not null,
  reaction_ms int,
  hold_ms int,
  created_at timestamptz not null default now()
);
create index touch_trials_session_id_idx on public.touch_trials (session_id);

alter table public.patients enable row level security;
alter table public.tutorials enable row level security;
alter table public.sessions enable row level security;
alter table public.repetitions enable row level security;
alter table public.touch_trials enable row level security;

create policy "public read patients" on public.patients for select to anon, authenticated using (true);
create policy "public add patients" on public.patients for insert to anon, authenticated with check (true);
create policy "public read tutorials" on public.tutorials for select to anon, authenticated using (true);
create policy "public read sessions" on public.sessions for select to anon, authenticated using (true);
create policy "public add sessions" on public.sessions for insert to anon, authenticated with check (true);
create policy "public update sessions" on public.sessions for update to anon, authenticated using (true) with check (true);
create policy "public read reps" on public.repetitions for select to anon, authenticated using (true);
create policy "public add reps" on public.repetitions for insert to anon, authenticated with check (true);
create policy "public read trials" on public.touch_trials for select to anon, authenticated using (true);
create policy "public add trials" on public.touch_trials for insert to anon, authenticated with check (true);

grant select, insert on public.patients to anon, authenticated;
grant select on public.tutorials to anon, authenticated;
grant select, insert, update on public.sessions to anon, authenticated;
grant select, insert on public.repetitions to anon, authenticated;
grant select, insert on public.touch_trials to anon, authenticated;

-- Tutorials: 8 rows were seeded (warm-up, finger flexion, tendon glides,
-- hold-and-release, blocking, thumb opposition, quick thumb touches,
-- thumb hold). Edit them in the Supabase Table Editor (table "tutorials").
