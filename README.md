# HatoCoins · Alimenta a Brissa

Experiencia interactiva para el stand de **HatoMaster**: la comunidad invierte
HatoCoins, las monedas vuelan al comedero, la comida cae dentro y Brissa se
alimenta hasta llenar la meta colectiva de **10,000 HM**.

Es una aplicación 100 % de front-end. No hay backend, ni base de datos, ni
llamadas a servicios externos: todo el estado vive en el `localStorage` del
navegador donde se está ejecutando.

---

## Qué hace

| Pieza | Detalle |
| --- | --- |
| **Meta colectiva** | Empieza siempre en `0 / 10,000`. El contador y el comedero suben con cada inversión. |
| **Flujo de inversión** | Cantidad → categoría (opcional) → confirmación → monedas volando → comida cayendo → comedero llenándose → reacción de Brissa. |
| **Cantidades** | Presets de `10` a `2,500` o cualquier entero positivo escrito a mano. |
| **Categorías** | 5 guías de inversión + opción "sin categoría". |
| **Distribución** | Barra de "donde está invirtiendo la comunidad" actualizada en vivo. |
| **Historial** | Últimas 5 inversiones con hora y categoría. |
| **Celebración** | Al cruzar la meta: confeti, cartel de logro y aviso de "meta superada". |
| **Sonido** | Efectos sintetizados con WebAudio (sin archivos). **Apagados por defecto.** |
| **Brissa** | 4 estados de ánimo SVG (esperando, recibiendo, feliz, alimentada). |

### El flujo, paso a paso

1. Se elige un monto (preset o captura manual).
2. Se pulsa **Continuar**.
3. Se escoge una categoría de inversión, o se deja sin categoría.
4. Se pulsa **Revisar inversión** → aparece el modal de confirmación.
5. Se pulsa **Invertir**. Entonces:
   - aparece la insignia **`+500 HM`** a pantalla completa,
   - las HatoCoins vuelan en arco hasta el comedero,
   - cae el alimento dentro del comedero,
   - el nivel del comedero sube con muelle,
   - el contador interpola su valor,
   - Brissa reacciona y se muestra el resumen de la inversión.

Si la inversión lleva la meta más allá de 10,000, el contador real se muestra
completo (`10,300`), la barra se queda en 100 % y aparece el aviso
`+300 HM sobre la meta`.

---

## Stack

- **Astro 5** (salida estática)
- **TypeScript** estricto
- **Tailwind CSS 4** vía `@tailwindcss/vite`
- **Supabase** (PostgreSQL + Realtime) como única fuente de verdad
- **Vanilla JS** para el motor de animación (sin librerías de UI ni de animación)

No se usa ningún paquete de animaciones: las monedas, las partículas, el
confeti y la celebración están escritos a mano con Web Animations API,
`requestAnimationFrame` y KEYframes CSS.

El estado del juego **no** se guarda en el navegador. Supabase lo mantiene
para que varias pantallas del stand muestren las mismas cifras en vivo; ver
[Almacenamiento](#almacenamiento).

---

## Puesta en marcha

```bash
npm install
npm run dev        # servidor de desarrollo (modo demo siempre disponible)
```

| Script | Qué hace |
| --- | --- |
| `npm run dev` | Servidor de desarrollo. |
| `npm run build` | Build estático en `dist/`. |
| `npm run preview` | Sirve `dist/` como lo haría producción. |
| `npm run check` | Diagnóstico de Astro + TypeScript. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Pruebas de la lógica pura (parser de montos y normalización de estado). |

---

## Despliegue en Vercel

El proyecto es estático, así que no hace falta configuración especial:

```bash
npm i -g vercel
vercel
```

O desde el dashboard: **New Project → Framework Preset: Astro**. Vercel detecta
`npm run build` y publica `dist/`.

Las variables `PUBLIC_*` se configuran en **Settings → Environment Variables**
del proyecto en Vercel.

---

## Configuración

Copia `.env.example` a `.env` y ajusta lo que necesites.

### 1. Base de datos (obligatoria)

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. Abre **SQL Editor** y pega el contenido de
   [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
   Crea las tablas, el trigger de acumulados, los tres RPC, las políticas RLS y
   añade ambas tablas a la publicación de Realtime.
3. En **Project Settings → API**, copia la URL y la `anon` key` a tu `.env`.

Sin esas dos variables la app **arranca pero no permite invertir**: muestra un
aviso "SIN CONEXIÓN CON LA BASE DE DATOS" y bloquea el panel. Es deliberado: si
la escritura fallara, la inversión del visitante se perdería sin dejar rastro.

### 2. Opcionales

| Variable | Efecto |
| --- | --- |
| `PUBLIC_SUPABASE_URL` | **Obligatoria.** URL del proyecto (Project Settings → API). |
| `PUBLIC_SUPABASE_ANON_KEY` | **Obligatoria.** Clave anónima. Es pública por diseño: es RLS quien protege los datos. |
| `PUBLIC_EVENT_ID` | Identificador del evento dentro de la base de datos. Cámbialo para tener varios actos independientes conviviendo. |
| `PUBLIC_BRISSA_ASSET` | Ruta o import del asset oficial de Brissa. Si se define, se usa en lugar del SVG placeholder. |
| `PUBLIC_ORG_PASSWORD` | Habilita el "Modo organización" protegido por contraseña (`Ctrl+Shift+O`). Si no se define, ese modo queda deshabilitado. |
| `PUBLIC_FORCE_DEMO` | `"1"` fuerza el modo demo también en producción. |

### Sustituir el dibujo de Brissa

El juego **nunca** depende de que exista el asset oficial. Hay dos formas:

```bash
# 1) Ruta dentro de /public
PUBLIC_BRISSA_ASSET=/brissa.png

# 2) Import desde src (lo empaqueta el build)
PUBLIC_BRISSA_ASSET=src/assets/brissa.png
```

Si no se define nada, `<Brissa />` dibuja su propio SVG placeholder, así que el
proyecto funciona y se ve completo desde el primer momento.

---

## Almacenamiento

El estado vive en **Supabase (PostgreSQL)**, no en `localStorage`. Así, si el
stand tiene varias pantallas (un TV principal y un panel de métricas), todas
muestran las mismas cifras y se actualizan en el instante en que alguien
invierte, sin recargar.

### Modelo de datos

Dos tablas:

- **`events`** — una fila por evento. Guarda los **acumulados** (`total_raised`,
  `category_totals`, `goal_reached`) que la app lee para pintar la pantalla.
- **`investments`** — registro *append-only* de cada inversión. Es la fuente de
  verdad; de aquí sale el historial.

Los acumulados están **desnormalizados a propósito**, y esto es lo importante:
un trigger de PostgreSQL (`investments_apply_totals`) los mantiene al día en
cada `INSERT` y en cada `DELETE`. Por eso dos pantallas que invierten en el
mismo instante no pueden pisarse entre sí — el clásico problema de
"leer-modificar-escribir" no existe aquí porque el cliente **nunca** calcula un
total, sólo lo lee.

```sql
--queda así, tras invertir 1000 de "ganadería" y 500 sin categoría:
select total_raised, category_totals from events where id = 'default';
  total_raised |        category_totals
--------------+---------------------------------
         1500 | {"ganaderia": 1000}
```

### Escrituras: tres RPC

| RPC | Qué hace |
| --- | --- |
| `add_investment(event, monto, categoría)` | Inserta y devuelve la fila del evento ya actualizada. Un solo viaje de ida y vuelta. |
| `undo_last_investment(event)` | Borra la inversión más reciente (modo organización). |
| `reset_event(event)` | Borra el historial y vuelve a 0 / meta. Afecta a **todas** las pantallas. |

El cliente nunca adivina: tras escribir, vuelve a leer el estado autoritativo y
la animación usa esa cifra. Si la escritura falla, **no hay animación** — es
mejor avisar que mostrar una subida que la base de datos no tiene.

### Realtime

La app se suscribe a dos canales filtrados por evento:

- `events` → llega el cambio de una fila con los acumulados: repinta total,
  barra y desglose.
- `investments` → llega cada inversión nueva: actualiza "última inversión" e
  historial.

### Qué sigue en el navegador

Sólo la preferencia de sonido (`hatomaster_brissa_settings`), y es a
propósito: es un ajuste **del dispositivo**. Si estuviera en la base de datos,
apagar el sonido en una pantalla silenciaría a todas las demás.

### Seguridad en producción

La `anon` key` va incrustada en el bundle: es pública por diseño, y lo que
protege los datos son las políticas RLS. Tal como está, **cualquiera que abra
la URL puede invertir, deshacer y reiniciar el evento**. Para un stand cerrado
(red interna) es aceptable; si el deployment es público en internet, conviene
mover `reset_event` y `undo_last_investment` detrás de una Edge Function que
use la `service_role` y pedir ese secreto en la interfaz de organización.

---

## Controles ocultos

| Atajo | Acción |
| --- | --- |
| `Ctrl+Shift+R` (mantener 3 s) | Reinicia el evento a `0 / 10,000` (con anillo de progreso). |
| `Ctrl+Shift+O` | Abre el Modo organización (requiere `PUBLIC_ORG_PASSWORD`). Permite deshacer la última inversión y reiniciar. |
| `Ctrl+Shift+D` | Muestra/oculta la barra de modo demo. |

### Modo demo

En desarrollo siempre está disponible con `Ctrl+Shift+D`. En producción se
activa con:

- `?demo=1` en la URL,
- `PUBLIC_FORCE_DEMO=1`,
- `Ctrl+Shift+D`.

La barra ofrece botones rápidos de `+100`, `+500`, `+1000` y `+2500` para
ensayar la dinámica del stand sin inversiones reales.

---

## Escenario fijo 16:9

El juego está diseñado para un **iterador 1920 × 1080**. Todo se compone sobre
un escenario fijo de 1920 × 1080 que se escala con un `transform: scale()` para
llenar cualquier pantalla, manteniendo las proporciones. El presupuesto vertical
está calculado para que la consola inferior, el panel de inversión y el botón de
invertir quepan **sin scroll** en 16:9.

---

## Estructura

```
src/
├─ pages/
│  └─ index.astro              Escenario 16:9 y composición del juego
├─ scripts/
│  └─ game.ts                  Controlador: flujo, teclado, sonido, demo, reinicio
├─ lib/
│  ├─ animations.ts            Motor de efectos: insignias, monedas, física, confeti
│  ├─ audio.ts                 Efectos de sonido sintetizados (WebAudio)
│  ├─ brissa.ts                Resolución del asset de Brissa y variables de entorno
│  ├─ config.ts                Meta, presets, categorías, hitos, textos y tiempos
│  ├─ gameState.ts             Store reactivo (async) con suscripciones
│  ├─ investments.ts           Formato, parser de montos, historial y distribución
│  ├─ repository.ts            Acceso a Supabase: lecturas, RPC y normalización
│  ├─ supabase.ts              Cliente, validación de credenciales y config
│  └─ types.ts                 Tipos del dominio
├─ components/
│  ├─ game/                    Brissa, comedero, cabecera, progreso, monedas, avisos, celebración
│  ├─ investment/              Selector, presets, captura manual, categorías, confirmación
│  ├─ stats/                   Distribución e historial
│  └─ ui/                      Botones y modales reutilizables
├─ styles/
│  └─ global.css               Tokens de diseño, tema y animaciones globales
supabase/
├─ migrations/
│  └─ 0001_init.sql            Tablas, trigger de acumulados, RPC, RLS, Realtime
└─ tests/
   └─ 0001_test.sql            37 aserciones sobre la migración
```

---

## Pruebas

```bash
npm test
```

Verifica la lógica pura que más riesgo de regresión tiene:

- **Parser de montos**: acepta `500`, `1,000`, `1.000`, `12 500`, `500 HM`;
  rechaza vacíos, `0`, negativos (`-5`), notación científica (`1e3`),
  separadores mal formados (`12,5,6`, `1.5`) y texto inválido.
- **Normalización de filas**: convierte filas de Supabase en un `GameState`
  íntegro. Descarta importes no numéricos, categorías inexistentes y registros
  corruptos; reconstruye el desglose si el `jsonb` llegó vacío; y nunca inventa
  un total (la base de datos es la autoridad).

### Pruebas de la migración

La lógica del trigger y de los RPC vive en PostgreSQL, así que se prueba
contra PostgreSQL. Con una base **vacía**:

```bash
createdb hatocoins_test
psql -d hatocoins_test -v ON_ERROR_STOP=1 -f supabase/migrations/0001_init.sql
psql -d hatocoins_test -v ON_ERROR_STOP=1 -f supabase/tests/0001_test.sql
```

37 aserciones: acumulados en `INSERT` y en `DELETE`, meta alcanzada y
superada, los tres RPC, `investments` inmutable, montos y categorías
rechazados, aislamiento entre eventos y las dos tablas dentro de la publicación
de Realtime. Cada aserción lanza una excepción si falla, así que con
`ON_ERROR_STOP=1` el script se detiene en el primer problema.

---

## Notas de implementación

- **Animaciones**: el escenario es fijo y las coordenadas de las monedas se
  calculan en el espacio 1920 × 1080, por lo que el origen y el destino se
  maintain correctos a cualquier escala de pantalla.
- **Tween del contador**: se lanza en segundo plano y su token de ejecución
  descarta los cuadros tardíos, para que una pestaña en segundo plano (donde el
  navegador pausa los `requestAnimationFrame`) no pueda pisar el estado de la
  inversión siguiente.
- **Sonido**: se sintetiza con osciladores de WebAudio, así que no hay archivos
  de audio que cargar. El botón de sonido vive en la cabecera.
- **Sin scroll**: el layout está dimensionado para que 1920 × 1080 sea
  suficiente; en viewports más estrechos el escenario se reduce proporcionalmente.
