-- ═══════════════════════════════════════════════════════════════════════
-- HatoCoins · pruebas del esquema (supabase/tests/0001_test.sql)
--
-- Se ejecuta contra la migración ya aplicada, en una base limpia:
--   psql -d hatocoins_test -f supabase/migrations/0001_init.sql
--   psql -d hatocoins_test -f supabase/tests/0001_test.sql
--
-- Devuelve un error (código 1) si algo falla, así que sirve tanto para CI
-- como para comprobar a mano antes de tocar el proyecto real.
--
-- La estrategia es INTENCIONADAMENTE hostil: se borra el evento entre bloques
-- para que cada uno parta de cero, y se prueban también los caminos que el
-- cliente nunca debería poder tomar (borrar filas, tocar las metas a mano).
-- ═══════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP off
\timing off
\pset pager off

create schema if not exists hatocoins_test;
set search_path = public, hatocoins_test;

-- ── Utilidades de aserción ───────────────────────────────────────────────
-- Las aserciones NO abortan el script: se registra cada fallo y se resume al
-- final. Si abortasen en la primera, un solo error escondería todos los
-- siguientes y el `\echo` de "todo pasó" mentiría.
create table if not exists hatocoins_test.failures (
  name text,
  seen text,
  want text
);
truncate hatocoins_test.failures;

create or replace function hatocoins_test.reset_state()
returns void language plpgsql as $$
begin
  -- El evento se borra en cascada y arrastra las inversiones: mismo punto de
  -- partida que un evento recién creado.
  delete from public.events where id = 'default';
  insert into public.events (id) values ('default');
end $$;

create or replace function hatocoins_test.expect(
  p_ok   boolean,
  p_name text,
  p_seen text default '',
  p_want text default ''
)
returns void language plpgsql as $$
begin
  if p_ok then
    raise notice '  ok   %', p_name;
  else
    insert into hatocoins_test.failures values (p_name, p_seen, p_want);
    raise warning '  FALLO  %  (obtenido: %, esperado: %)', p_name, p_seen, p_want;
  end if;
end $$;

create or replace function hatocoins_test.eq_int(
  p_name text, p_seen bigint, p_want bigint
) returns void language sql as $$
  select hatocoins_test.expect(p_seen = p_want, p_name, p_seen::text, p_want::text);
$$;

create or replace function hatocoins_test.eq_text(
  p_name text, p_seen text, p_want text
) returns void language sql as $$
  select hatocoins_test.expect(p_seen is not distinct from p_want, p_name,
                               coalesce(p_seen, 'null'), coalesce(p_want, 'null'));
$$;

create or replace function hatocoins_test.eq_bool(
  p_name text, p_seen boolean, p_want boolean
) returns void language sql as $$
  select hatocoins_test.expect(coalesce(p_seen, false) = coalesce(p_want, false),
                               p_name, coalesce(p_seen, false)::text, p_want::text);
$$;

-- Lee una columna numérica del evento sin abortar si está a NULL.
create or replace function hatocoins_test.field(
  p_col text, p_event text default 'default'
) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('select %I::bigint from public.events where id = $1', p_col)
    into v using p_event;
  return v;
end $$;

create or replace function hatocoins_test.cat(
  p_category text, p_event text default 'default'
) returns bigint language plpgsql as $$
declare v bigint;
begin
  select coalesce((category_totals ->> p_category)::bigint, 0) into v
  from public.events where id = p_event;
  return v;
end $$;


-- ═══════════════════════════════════════════════════════════════════════
-- 1 · El evento recién creado
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '1 · evento recién creado'
select hatocoins_test.reset_state();

select hatocoins_test.eq_int('total a 0',  hatocoins_test.field('total_raised'), 0);
select hatocoins_test.eq_int('meta inicial', hatocoins_test.field('goal'), 100000);
select hatocoins_test.eq_int('paso de meta', hatocoins_test.field('goal_step'), 100000);
select hatocoins_test.eq_int('ninguna meta superada', hatocoins_test.field('tiers_reached'), 0);
select hatocoins_test.eq_int('historial vacío',
  (select count(*) from public.investments where event_id = 'default'), 0);


-- ═══════════════════════════════════════════════════════════════════════
-- 2 · Una inversión normal sube el total y no toca la meta
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '2 · inversión por debajo del umbral'
select hatocoins_test.reset_state();

select add_investment('default', 250, 'ganaderia');
select hatocoins_test.eq_int('total',  hatocoins_test.field('total_raised'), 250);
select hatocoins_test.eq_int('categoría', hatocoins_test.cat('ganaderia'), 250);
select hatocoins_test.eq_int('meta intacta', hatocoins_test.field('goal'), 100000);
select hatocoins_test.eq_int('tiers intactos', hatocoins_test.field('tiers_reached'), 0);

select hatocoins_test.eq_bool('tier_upgraded = false',
  (add_investment('default', 100, 'ia') ->> 'tier_upgraded')::boolean, false);
select hatocoins_test.eq_int('total tras la 2ª', hatocoins_test.field('total_raised'), 350);

-- El RPC devuelve el evento entero, no sólo el total.
select hatocoins_test.eq_int('el sobre trae el total actual',
  ((add_investment('default', 50, null) -> 'event' ->> 'total_raised')::bigint), 400);
select hatocoins_test.eq_int('sin categoría no inventa la clave "datos"',
  hatocoins_test.cat('datos'), 0);


-- ═══════════════════════════════════════════════════════════════════════
-- 3 · Al cruzar la meta, la meta SUBE sola
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '3 · cruce exacto de la meta (100.000 → 200.000)'
select hatocoins_test.reset_state();

-- 99.999: todavía no.
select add_investment('default', 99999, null);
select hatocoins_test.eq_int('meta quieta en 100.000', hatocoins_test.field('goal'), 100000);
select hatocoins_test.eq_int('tiers en 0', hatocoins_test.field('tiers_reached'), 0);

-- 1 más: el umbral se alcanza exactamente y la meta avanza.
select hatocoins_test.eq_bool('tier_upgraded = true',
  (add_investment('default', 1, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('total', hatocoins_test.field('total_raised'), 100000);
select hatocoins_test.eq_int('meta subida a 200.000', hatocoins_test.field('goal'), 200000);
select hatocoins_test.eq_int('tiers = 1', hatocoins_test.field('tiers_reached'), 1);
select hatocoins_test.eq_int('el paso no cambia', hatocoins_test.field('goal_step'), 100000);

-- 99.999 más: no vuelve a cruzar (199.999 < 200.000).
select hatocoins_test.eq_bool('todavía no cruza',
  (add_investment('default', 99999, null) ->> 'tier_upgraded')::boolean, false);
select hatocoins_test.eq_int('meta quieta en 200.000', hatocoins_test.field('goal'), 200000);
select hatocoins_test.eq_int('tiers siguen en 1', hatocoins_test.field('tiers_reached'), 1);

-- 1 más: segunda meta.
select hatocoins_test.eq_bool('segundo cruce',
  (add_investment('default', 1, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('meta subida a 300.000', hatocoins_test.field('goal'), 300000);
select hatocoins_test.eq_int('tiers = 2', hatocoins_test.field('tiers_reached'), 2);


-- ═══════════════════════════════════════════════════════════════════════
-- 4 · Una inversión puede cruzar VARIAS metas de golpe
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '4 · una sola inversión que atraviesa tres umbrales'
select hatocoins_test.reset_state();

-- 250.000 de golpe: cruza 100.000, 200.000 y deja 300.000 como vigente.
select hatocoins_test.eq_bool('tier_upgraded = true (una vez, no tres)',
  (add_investment('default', 250000, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('total íntegro', hatocoins_test.field('total_raised'), 250000);
select hatocoins_test.eq_int('meta vigente = 300.000', hatocoins_test.field('goal'), 300000);
select hatocoins_test.eq_int('tiers = 2 (100k y 200k)', hatocoins_test.field('tiers_reached'), 2);

-- 500.000 de golpe desde cero: la meta debe quedar por encima, no igual.
select hatocoins_test.reset_state();
select add_investment('default', 500000, null);
select hatocoins_test.eq_int('meta por encima del total', hatocoins_test.field('goal'), 600000);
select hatocoins_test.eq_int('tiers = 5', hatocoins_test.field('tiers_reached'), 5);
select hatocoins_test.expect(
  hatocoins_test.field('goal') > hatocoins_test.field('total_raised'),
  'la meta nunca queda igualada al total (el progreso no se queda en 100 %)');

-- Justo por debajo de un múltiplo exacto: 400.000 deja meta 500.000.
select hatocoins_test.reset_state();
select add_investment('default', 400000, null);
select hatocoins_test.eq_int('meta = 500.000', hatocoins_test.field('goal'), 500000);
select hatocoins_test.eq_int('tiers = 4', hatocoins_test.field('tiers_reached'), 4);


-- ═══════════════════════════════════════════════════════════════════════
-- 5 · Deshacer baja el total pero NUNCA la meta
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '5 · deshacer no retrocede la meta'
select hatocoins_test.reset_state();

select add_investment('default', 100000, 'ia');
select hatocoins_test.eq_int('meta subida a 200.000', hatocoins_test.field('goal'), 200000);
select hatocoins_test.eq_int('categoría acumulada', hatocoins_test.cat('ia'), 100000);

-- Deshacer una inversión de 500 después de haber cruzado la meta.
select add_investment('default', 500, 'datos');
select hatocoins_test.eq_bool('deshacer no celebra',
  (undo_last_investment('default') ->> 'tier_upgraded')::boolean, false);
select hatocoins_test.eq_int('total baja', hatocoins_test.field('total_raised'), 100000);
select hatocoins_test.eq_int('categoría también baja', hatocoins_test.cat('datos'), 0);
select hatocoins_test.eq_int('LA META NO BAJA', hatocoins_test.field('goal'), 200000);
select hatocoins_test.eq_int('los tiers NO bajan', hatocoins_test.field('tiers_reached'), 1);

-- Deshacer la que cruzó la meta tampoco la deshace.
select undo_last_investment('default');
select hatocoins_test.eq_int('total a 0', hatocoins_test.field('total_raised'), 0);
select hatocoins_test.eq_int('la meta sigue en 200.000', hatocoins_test.field('goal'), 200000);
select hatocoins_test.eq_int('los tiers siguen en 1', hatocoins_test.field('tiers_reached'), 1);
select hatocoins_test.cat('ia');

-- Y el evento sigue vivo: se puede seguir invirtiendo sin "reiniciar" nada.
select add_investment('default', 100, null);
select hatocoins_test.eq_int('sigue acumulando', hatocoins_test.field('total_raised'), 100);
select hatocoins_test.eq_int('meta intacta', hatocoins_test.field('goal'), 200000);

-- Deshacer sobre un evento vacío no rompe nada.
select hatocoins_test.reset_state();
select undo_last_investment('default');
select hatocoins_test.eq_int('total sigue a 0', hatocoins_test.field('total_raised'), 0);
select hatocoins_test.eq_int('meta intacta', hatocoins_test.field('goal'), 100000);


-- ═══════════════════════════════════════════════════════════════════════
-- 6 · Categorías
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '6 · reparto por categoría'
select hatocoins_test.reset_state();

select add_investment('default', 100, 'ganaderia');
select add_investment('default', 200, 'ia');
select add_investment('default', 300, 'datos');
select add_investment('default', 400, 'offline');
select add_investment('default', 500, 'rural');
select add_investment('default', 600, null);

select hatocoins_test.eq_int('suma = total', hatocoins_test.field('total_raised'), 2100);
select hatocoins_test.eq_int('ganadería', hatocoins_test.cat('ganaderia'), 100);
select hatocoins_test.eq_int('ia',        hatocoins_test.cat('ia'),        200);
select hatocoins_test.eq_int('datos',      hatocoins_test.cat('datos'),      300);
select hatocoins_test.eq_int('offline',    hatocoins_test.cat('offline'),    400);
select hatocoins_test.eq_int('rural',      hatocoins_test.cat('rural'),      500);
select hatocoins_test.eq_int('sin categoría no inventa una clave nueva',
  (select count(*) from jsonb_object_keys((select category_totals from public.events where id = 'default')) s), 5);

-- Un total nunca puede quedar por debajo de cero ni una categoría negativa.
select hatocoins_test.reset_state();
select add_investment('default', 50, 'ia');
delete from public.investments where event_id = 'default';
select hatocoins_test.eq_int('total a 0 tras borrar el log', hatocoins_test.field('total_raised'), 0);
select hatocoins_test.eq_int('categoría a 0 (no negativa)', hatocoins_test.cat('ia'), 0);
select hatocoins_test.eq_int('categoría inexistente a 0', hatocoins_test.cat('rural'), 0);


-- ═══════════════════════════════════════════════════════════════════════
-- 7 · El log es append-only y el trigger es la única vía de escritura
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '7 · el log es append-only'
select hatocoins_test.reset_state();
select add_investment('default', 1000, 'ia');

-- Una fila insertada a pelo (no por el RPC) SÍ mueve los acumulados: el trigger
-- es la autoridad, no el RPC. Esto es lo que garantiza que ninguna pantalla
-- pueda dejar el total descuadrado.
insert into public.investments (event_id, amount, category) values ('default', 500, 'datos');
select hatocoins_test.eq_int('el trigger también cuenta la inserción directa',
  hatocoins_test.field('total_raised'), 1500);
select hatocoins_test.eq_int('y su categoría', hatocoins_test.cat('datos'), 500);

-- La fila es inmutable: el trigger sólo escucha INSERT y DELETE, así que un
-- UPDATE cambiaría el importe del log sin mover los acumulados y el total
-- quedaría mentiroso para siempre.
--
-- Aquí NO se puede comprobar con un UPDATE directo porque esta sesión corre
-- como `postgres`, que es superusuario y se salta RLS y los grants: sí podría
-- hacerlo, y por eso la protección real NO es la política sino el permiso
-- (se comprueba en la sección 9: `anon` no tiene UPDATE). Lo que se comprueba
-- aquí es que no exista siquiera una política que lo autorice.
select hatocoins_test.eq_int('no hay política de UPDATE en el log',
  (select count(*)::bigint from pg_policies
   where schemaname = 'public' and tablename = 'investments' and cmd = 'UPDATE'), 0);
-- pg_trigger.tgtype es una máscara de bits: 2=DELETE, 4=INSERT, 8=UPDATE,
-- 16=TRUNCATE. El trigger debe ser exactamente INSERT|DELETE (6): si algún
-- día se le añadiera UPDATE, un cambio de importe movería el log sin tocar los
-- acumulados.
select hatocoins_test.eq_int('el trigger cubre sólo INSERT y DELETE',
  (select coalesce(max(tgtype::int), -1) from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
   where c.relname = 'investments' and not t.tgisinternal),
  6);
select hatocoins_test.eq_int('no hay trigger extra en el log',
  (select count(*)::bigint from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
   where c.relname = 'investments' and not t.tgisinternal), 1);

-- Un importe no positivo o una categoría inventada no pueden entrar.
do $$
declare caught text;
begin
  begin perform add_investment('default', 0, null);
  exception when others then caught := sqlerrm; end;
  perform hatocoins_test.expect(caught = 'invalid_amount', 'importe 0 rechazado',
                                coalesce(caught, 'no falló'), 'invalid_amount');

  caught := null;
  begin perform add_investment('default', -50, null);
  exception when others then caught := sqlerrm; end;
  perform hatocoins_test.expect(caught = 'invalid_amount', 'importe negativo rechazado',
                                coalesce(caught, 'no falló'), 'invalid_amount');

  caught := null;
  begin perform add_investment('default', 10, 'inventada');
  exception when others then caught := sqlerrm; end;
  perform hatocoins_test.expect(caught = 'invalid_category', 'categoría inventada rechazada',
                                coalesce(caught, 'no falló'), 'invalid_category');

  caught := null;
  begin perform add_investment('evento-inexistente', 10, null);
  exception when others then caught := sqlerrm; end;
  perform hatocoins_test.expect(caught = 'unknown_event', 'evento inexistente rechazado',
                                coalesce(caught, 'no falló'), 'unknown_event');

end $$;

-- El total no cambia con ninguna de esas llamadas fallidas.
select hatocoins_test.eq_int('el total sigue en 1.500', hatocoins_test.field('total_raised'), 1500);


-- ═══════════════════════════════════════════════════════════════════════
-- 8 · Aislamiento entre eventos
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '8 · varios eventos en la misma tabla'
select hatocoins_test.reset_state();
insert into public.events (id) values ('jornada-2');

select add_investment('default', 100, 'ia');
select add_investment('jornada-2', 999, 'rural');
select add_investment('default', 50, 'datos');

select hatocoins_test.eq_int('default = 150', hatocoins_test.field('total_raised', 'default'), 150);
select hatocoins_test.eq_int('jornada-2 = 999', hatocoins_test.field('total_raised', 'jornada-2'), 999);
select hatocoins_test.eq_int('la meta de default no se movió',
  hatocoins_test.field('goal', 'default'), 100000);

-- Deshacer sólo toca su propio evento.
select undo_last_investment('jornada-2');
select hatocoins_test.eq_int('jornada-2 a 0', hatocoins_test.field('total_raised', 'jornada-2'), 0);
select hatocoins_test.eq_int('default intacto', hatocoins_test.field('total_raised', 'default'), 150);

-- Cada evento puede tener su propio paso de meta.
update public.events set goal_step = 50000 where id = 'jornada-2';
-- Meta 100.000 con paso 50.000: 100.000 alcanza el primer umbral (150.000) y
-- aún no llega al segundo, así que sube una sola vez.
select hatocoins_test.eq_bool('un único umbral cruzado',
  (add_investment('jornada-2', 100000, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('meta 100.000 → 150.000',
  hatocoins_test.field('goal', 'jornada-2'), 150000);
select hatocoins_test.eq_int('tiers = 1', hatocoins_test.field('tiers_reached', 'jornada-2'), 1);

-- 100.000 más: ahora sí cruza los dos umbrales de golpe.
select hatocoins_test.eq_bool('dos umbrales de golpe',
  (add_investment('jornada-2', 100000, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('meta 150.000 → 250.000',
  hatocoins_test.field('goal', 'jornada-2'), 250000);
select hatocoins_test.eq_int('tiers = 3', hatocoins_test.field('tiers_reached', 'jornada-2'), 3);

-- Evento con meta y paso personalizados desde el INSERT: paso pequeño y
-- asalto grande. Es el caso límite del bucle: se encadena hasta que la meta
-- queda por encima del total, y el total nunca se toca.
insert into public.events (id, goal, goal_step) values ('jornada-3', 1000, 250);
select hatocoins_test.eq_bool('tier_upgraded una sola vez, valga lo que valga',
  (add_investment('jornada-3', 4000, null) ->> 'tier_upgraded')::boolean, true);
select hatocoins_test.eq_int('total íntegro', hatocoins_test.field('total_raised', 'jornada-3'), 4000);
-- La meta se mantiene múltiplo del paso por encima del total: 1000 + 13×250.
select hatocoins_test.eq_int('meta 1000 paso 250 → 4250 (13 saltos)',
  hatocoins_test.field('goal', 'jornada-3'), 4250);
select hatocoins_test.eq_int('tiers = 13', hatocoins_test.field('tiers_reached', 'jornada-3'), 13);
-- Ni meta ni tiers se han inventado cifras: deben ser coherentes entre sí.
select hatocoins_test.eq_int('tiers = (meta - meta_inicial) / paso',
  hatocoins_test.field('tiers_reached', 'jornada-3'),
  (hatocoins_test.field('goal', 'jornada-3') - 1000) / 250);
-- El invariante que manda: la meta vigente SIEMPRE por encima del total. Si
-- quedara igualada, la barra se quedaría clavada en 100 % y parecería un fallo.
select hatocoins_test.expect(
  hatocoins_test.field('goal', 'jornada-3') > hatocoins_test.field('total_raised', 'jornada-3'),
  'la meta vigente supera siempre al total');

delete from public.events where id in ('jornada-2', 'jornada-3');


-- ═══════════════════════════════════════════════════════════════════════
-- 9 · Cierre de caja: los totales cuadran con el log
-- ═══════════════════════════════════════════════════════════════════════
\echo ''
\echo '9 · los acumulados cuadran con el log'
select hatocoins_test.reset_state();

insert into public.investments (event_id, amount, category)
values ('default', 10, 'ia'), ('default', 20, 'ia'),
       ('default', 30, 'datos'), ('default', 40, null);

select hatocoins_test.eq_int('total = suma del log',
  hatocoins_test.field('total_raised'),
  (select sum(amount)::bigint from public.investments where event_id = 'default'));
select hatocoins_test.eq_int('categoría ia = 30',
  hatocoins_test.cat('ia'),
  (select coalesce(sum(amount), 0)::bigint from public.investments
   where event_id = 'default' and category = 'ia'));
select hatocoins_test.eq_int('sin categoría no cuenta para ninguna',
  (select coalesce(sum(j.value::bigint), 0)::bigint from public.events e,
       jsonb_each_text(e.category_totals) j where e.id = 'default'),
  hatocoins_test.field('total_raised'));

-- El ORDER BY del deshacer: con dos filas del mismo milisegundo, deshace la
-- más reciente (el id crece con la inserción).
select hatocoins_test.reset_state();
insert into public.investments (event_id, amount, category) values ('default', 111, null);
insert into public.investments (event_id, amount, category) values ('default', 222, null);
select undo_last_investment('default');
select hatocoins_test.eq_int('deshace la última (222)', hatocoins_test.field('total_raised'), 111);

-- realtime: ambas tablas tienen que estar en la publicación
select hatocoins_test.eq_int('events está en supabase_realtime',
  (select count(*)::bigint from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'events'), 1);
select hatocoins_test.eq_int('investments está en supabase_realtime',
  (select count(*)::bigint from pg_publication_tables
   where pubname = 'supabase_realtime' and tablename = 'investments'), 1);

-- RLS activado en las dos
select hatocoins_test.expect(
  (select relrowsecurity from pg_class where relname = 'events'),
  'RLS activo en events');
select hatocoins_test.expect(
  (select relrowsecurity from pg_class where relname = 'investments'),
  'RLS activo en investments');

-- `anon` no puede falsear los acumulados: sin UPDATE/DELETE directos.
select hatocoins_test.eq_int('anon no puede UPDATE en events',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'events' and privilege_type = 'UPDATE'), 0);
select hatocoins_test.eq_int('anon no puede DELETE en events',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'events' and privilege_type = 'DELETE'), 0);
select hatocoins_test.eq_int('anon no puede UPDATE en investments',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'investments' and privilege_type = 'UPDATE'), 0);
select hatocoins_test.eq_int('anon no puede DELETE en investments',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'investments' and privilege_type = 'DELETE'), 0);
select hatocoins_test.eq_int('anon no puede INSERT en investments',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'investments' and privilege_type = 'INSERT'), 0);
select hatocoins_test.eq_int('anon sí puede leer investments',
  (select count(*)::bigint from information_schema.role_table_grants
   where grantee = 'anon' and table_name = 'investments' and privilege_type = 'SELECT'), 1);
select hatocoins_test.eq_int('anon puede ejecutar add_investment',
  (select count(*)::bigint from information_schema.role_routine_grants
   where grantee = 'anon' and routine_name = 'add_investment'), 1);

-- Ninguna función privileged queda abierta a PUBLIC.
select hatocoins_test.eq_int('las funciones no están abiertas a PUBLIC',
  (select count(*)::bigint from information_schema.routine_privileges
   where grantee = 'PUBLIC' and routine_name in
     ('add_investment', 'undo_last_investment', 'events_apply_investment')), 0);

select hatocoins_test.reset_state();

-- ── Resumen ─────────────────────────────────────────────────────────────
-- Se cuenta lo que ha pasado de verdad. El script usa `raise warning`, no
-- `raise exception`, así que sigue hasta aquí y este es el veredicto real: un
-- `\echo` de "todo pasó" sin contarlos habría dado un falso verde.
\echo ''
select
  (select count(*) from hatocoins_test.failures) as fallos,
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'hatocoins_test' and p.proname in ('expect', 'eq_int')) as aserciones;

do $$
declare v_fallos integer;
        v_linea  text;
begin
  select count(*) into v_fallos from hatocoins_test.failures;

  for v_linea in
    select format('  · %s (obtenido: %s / esperado: %s)', name, seen, want)
    from hatocoins_test.failures order by name
  loop
    raise warning '%', v_linea;
  end loop;

  if v_fallos > 0 then
    raise exception '══ % PRUEBAS FALLARON ══', v_fallos;
  end if;
  raise notice '══ TODAS LAS PRUEBAS DEL ESQUEMA PASARON ══';
end $$;
