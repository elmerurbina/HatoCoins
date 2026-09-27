-- ═══════════════════════════════════════════════════════════════════════
-- HatoCoins · esquema de Supabase
--
-- Aplicar en el SQL Editor de Supabase (o con `supabase db push`).
-- Ejecutar de principio a fin: es idempotente salvo los `drop policy`.
--
-- MODELO
--   events       Una fila por evento del stand. Guarda los ACUMULADOS
--                (total_raised, category_totals) que lee la aplicación.
--   investments  Registro append-only de cada inversión. Es la fuente de
--                verdad; los acumulados de `events` los mantiene un trigger.
--
-- POR QUÉ DENORMALIZAR
--   La app necesita el total y el desglose por categoría en UNA sola fila
--   para pintar la pantalla al instante. Con Realtime, un UPDATE en esa fila
--   llega a todas las pantallas del stand en milisegundos, sin recalcular
--   nada en el cliente y sin traer el historial entero.
--
-- ⚠️ SEGURIDAD
--   La `publishable key` de Supabase va incrustada en el bundle: es pública
--   por diseño. Lo que el navegador puede hacer se reduce a LEER el estado y
--   llamar a los RPC: no hay `delete` ni `update` directos sobre las tablas,
--   así que ni el total ni las metas se pueden falsear desde fuera. La única
--   escritura destructiva al alcance es `undo_last_investment`; para cerrarla
--   del todo, moverla a una Edge Function con `service_role` (ver README,
--   sección "Seguridad en producción").
-- ═══════════════════════════════════════════════════════════════════════

-- ── events ──────────────────────────────────────────────────────────────
create table if not exists public.events (
  id              text primary key,
  goal            integer     not null default 100000 check (goal > 0),
  goal_step       integer     not null default 100000 check (goal_step > 0),
  tiers_reached   integer     not null default 0    check (tiers_reached >= 0),
  total_raised    bigint      not null default 0      check (total_raised >= 0),
  category_totals jsonb       not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- `goal` es la META VIGENTE, no un techo. Al alcanzarla, el trigger la sube
-- sola en saltos de `goal_step`: 100.000 → 200.000 → 300.000 … y así hasta
-- donde llegue la comunidad. No existe un final ni un botón de reinicio.
-- `tiers_reached` cuenta cuántas metas se han superado, para poder celebrar
-- cada una. `total_raised` nunca se toca al avanzar la meta.

comment on table public.events is
  'Estado agregado de cada evento del stand. Los totales y el avance de metas los mantiene el trigger investments_apply_totals.';

-- ── investments ─────────────────────────────────────────────────────────
create table if not exists public.investments (
  id         bigint generated always as identity primary key,
  event_id   text        not null references public.events (id) on delete cascade,
  amount     integer     not null check (amount > 0),
  category   text        check (category is null or category in ('ganaderia', 'ia', 'datos', 'offline', 'rural')),
  created_at timestamptz not null default now()
);

create index if not exists investments_event_created_idx
  on public.investments (event_id, created_at desc);

comment on table public.investments is
  'Registro append-only de inversiones. Sólo se inserta y se borra (deshacer). Nunca se trunca.';

-- ── Trigger: mantiene `events` al día ───────────────────────────────────
create or replace function public.events_apply_investment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount   integer := 0;
  v_category text;
  v_event    text;
  v_total    bigint;
  v_goal     integer;
  v_step     integer;
  v_tiers    integer;
begin
  if tg_op = 'INSERT' then
    v_amount   := new.amount;
    v_category := new.category;
    v_event    := new.event_id;
  else
    v_amount   := -old.amount;
    v_category := old.category;
    v_event    := old.event_id;
  end if;

  -- `for update` bloquea la fila del evento: dos inversiones simultáneas desde
  -- dos kioscos leen y escriben la meta en serie, así que ninguna se pierde un
  -- salto por haber leído un total viejo.
  select e.total_raised, e.goal, e.goal_step, e.tiers_reached
    into v_total, v_goal, v_step, v_tiers
  from public.events e
  where e.id = v_event
  for update;

  if v_goal is null then
    -- El evento se borró en cascada; no hay agregado que mantener.
    return null;
  end if;

  v_total := greatest(0::bigint, v_total + v_amount);

  -- La meta sube SÓLO al añadir, y tantas veces como umbrales atraviese esa
  -- única inversión: un solo aporte de 250.000 sobre un evento en cero cruza
  -- 100.000, 200.000 y 300.000. Con un `if` único sólo habría comptentado uno y
  -- la meta se quedaría 200.000 por debajo de lo ya.tmado. Al deshacer NO se
  -- retrocede: bajar la meta por un error de tecleo destruiría el progreso de
  -- miles de inversiones ya hechas.
  if tg_op = 'INSERT' then
    while v_total >= v_goal loop
      v_goal  := v_goal + v_step;
      v_tiers := v_tiers + 1;
    end loop;
  end if;

  update public.events e
  set total_raised    = v_total,
      goal            = v_goal,
      goal_step       = v_step,
      tiers_reached   = v_tiers,
      category_totals = case
        when v_category is null then coalesce(e.category_totals, '{}'::jsonb)
        else jsonb_set(
               coalesce(e.category_totals, '{}'::jsonb),
               array[v_category],
               to_jsonb(greatest(0::bigint, coalesce((e.category_totals ->> v_category)::bigint, 0) + v_amount)),
               true)
      end,
      updated_at = now()
  where e.id = v_event;

  -- AFTER trigger: el valor de retorno se ignora. Se devuelve NULL para no
  -- tocar NEW, que en un DELETE no está asignado.
  return null;
end;
$$;

drop trigger if exists investments_apply_totals on public.investments;
create trigger investments_apply_totals
  after insert or delete on public.investments
  for each row execute function public.events_apply_investment();

-- ── RPC: registrar inversión ────────────────────────────────────────────
-- Devuelve jsonb y no la fila pelada porque el cliente necesita saber si esta
-- inversión cruzó una meta (para celebrar) y eso no cabe en una fila.
--   { event: <fila de events>, tier_upgraded: <bool> }
create or replace function public.add_investment(
  p_event_id  text,
  p_amount    integer,
  p_category  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before  public.events;
  v_after   public.events;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'invalid_amount' using errcode = '22023';
  end if;
  -- Se valida aquí y no sólo con el CHECK de la tabla para devolver un error
  -- legible en lugar de un 23514 que el cliente no sabe interpretar.
  if p_category is not null
     and p_category not in ('ganaderia', 'ia', 'datos', 'offline', 'rural') then
    raise exception 'invalid_category' using errcode = '22023';
  end if;

  select * into v_before from public.events where id = p_event_id;
  if v_before.id is null then
    raise exception 'unknown_event' using errcode = '22023';
  end if;

  insert into public.investments (event_id, amount, category)
  values (p_event_id, p_amount, p_category);

  select * into v_after from public.events where id = p_event_id;

  return jsonb_build_object(
    'event',         to_jsonb(v_after),
    -- La metaVED estaba por encima del total Y ahora es mayor: se cruzó. Si una
    -- inversión atraviesa tres umbrales de golpe, `goal` sube tres pasos y esto
    -- sigue siendo true: alcanza con celebrar una vez.
    'tier_upgraded', (v_before.total_raised < v_before.goal)
                     and (v_after.goal > v_before.goal)
  );
end;
$$;

-- ── RPC: deshacer la última inversión ───────────────────────────────────
-- Corrige un error de tecleo. NO baja la meta: si alguien ya meresió la meta
-- de 200.000, deshacer una inversión de 500 no devuelve el evento a 100.000.
create or replace function public.undo_last_investment(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after public.events;
begin
  delete from public.investments
  where id = (
    select id from public.investments
    where event_id = p_event_id
    order by created_at desc, id desc
    limit 1
  );

  select * into v_after from public.events where id = p_event_id;
  return jsonb_build_object('event', to_jsonb(v_after), 'tier_upgraded', false);
end;
$$;

-- ── Entorno: rol `anon` y publicación de Realtime ───────────────────────
-- En Supabase ambos ya existen y esto no hace nada. Se crean si faltan para
-- que la migración también se pueda aplicar tal cual en un Postgres limpio
-- (integración continua, staging, pruebas locales) sin editar el fichero.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- Permisos explícitos y mínimos: no se depende de los `default privileges` del
-- proyecto (que pueden haber cambiado) ni se concede más de lo necesario.
--
-- ⚠️ `anon` NO recibe `delete` ni `update`:
--   · `investments` es un log y sólo se toca desde los RPC, que son
--     `security definer`. Con `delete` en la tabla, cualquiera con la
--     publishable key (que va incrustada en el bundle) podría mandar un
--     `DELETE` a PostgREST y vaciar el evento sin pasar por la app.
--   · `events` sólo se actualiza desde el trigger; el cliente únicamente lee y
--     crea la fila del evento al arrancar.
grant usage on schema public to anon;
-- `events` se inserta al arrancar (el alta del evento) y se lee siempre.
grant select, insert on public.events      to anon;
-- `investments` sólo se LEE desde el cliente. Cualquier escritura pasa por los
-- RPC, que validan antes de tocar el log.
grant select              on public.investments to anon;

-- Las funciones son `security definer`: sin este revoke, `PUBLIC` las ejecutaría
-- con esos mismos permisos y las políticas de RLS de abajo no las tocarían.
revoke all on function public.add_investment(text, integer, text)            from public;
revoke all on function public.undo_last_investment(text)                    from public;
revoke all on function public.events_apply_investment()                     from public;
grant execute on function public.add_investment(text, integer, text)        to anon;
-- `undo_last_investment` sigue abierta al público: es el único botón de
-- corrección de errores y no hay autenticación en el kiosco. Si algún día hace
-- falta protegerla, va detrás de una Edge Function con `service_role`
-- (ver README, sección "Seguridad en producción").
grant execute on function public.undo_last_investment(text)                to anon;

-- ── RLS ─────────────────────────────────────────────────────────────────
-- La publishable key es pública. Estas políticas habilitan el kiosco.
alter table public.events      enable row level security;
alter table public.investments enable row level security;

drop policy if exists "kiosco: leer eventos"       on public.events;
drop policy if exists "kiosco: crear eventos"     on public.events;
drop policy if exists "kiosco: actualizar eventos" on public.events;
drop policy if exists "kiosco: borrar eventos"    on public.events;

create policy "kiosco: leer eventos"       on public.events for select to anon using (true);
create policy "kiosco: crear eventos"     on public.events for insert to anon with check (true);
-- Sin política de UPDATE ni DELETE a propósito: los acumulados y el avance de
-- metas los escribe el trigger, que corre como `security definer`.

-- `investments` es append-only y write-only-por-RPC: no hay política de
-- INSERT, UPDATE ni DELETE a propósito. Se lee (historial) y se escribe
--sólo a través del RPC, que es `security definer`.
drop policy if exists "kiosco: leer inversiones"       on public.investments;
drop policy if exists "kiosco: crear inversiones"     on public.investments;
drop policy if exists "kiosco: borrar inversiones"    on public.investments;

create policy "kiosco: leer inversiones"    on public.investments for select to anon using (true);

-- ── Realtime ────────────────────────────────────────────────────────────
-- Sin esto, las demás pantallas no se enteran de las inversiones.
-- `alter publication` falla si la tabla ya está en la publicación, por eso
-- se envuelve; por lo mismo hay que ejecutarlo una vez por proyecto.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'events'
  ) then
    alter publication supabase_realtime add table public.events;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'investments'
  ) then
    alter publication supabase_realtime add table public.investments;
  end if;
end $$;
