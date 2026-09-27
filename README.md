# HatoCoins · Rifa de Price Discovery

Rifa interactiva donde el usuario invierte HatoCoins y **ordeña a Brissa** para
descubrir un premio aleatorio. Proyecto Astro, 100 % client-side: sin base de
datos, sin claves y sin servicios externos.

## Comandos

```bash
npm install
npm run dev        # servidor de desarrollo
npm run build      # build estático a dist/
npm run preview    # sirve dist/
npm run check      # astro check (diagnósticos de .astro)
npm run typecheck  # tsc --noEmit
```

## Cómo funciona

1. El usuario escribe un monto (o pulsa uno de los atajos `1`–`9`).
2. La barra de probabilidades muestra en vivo el chances de cada nivel.
3. Al pulsar **ORDEÑAR A BRISSA** los tres reels giran y se bloquean uno a uno.
4. Se revela el premio con su imagen y se descuenta del inventario.

### Niveles y umbrales

| Nivel | Requisito | Stock | Peso base |
| --- | --- | --- | --- |
| 📌 Sticker | cualquier monto | 5 diseños × 20 unidades | 12 |
| 📄 Folleto | cualquier monto | 12 unidades | 6 |
| 🎖️ Certificado | `> 10 000 HM` | 20 unidades | 3 |
| 🔑 Llavero Premium | `> 25 000 HM` | 10 unidades | 2.5 |

Los umbrales son **estrictamente mayores**. La probabilidad de cada nivel escala
con la inversión: la rampa va de `0.18` a `1.0` entre el umbral y `3×` el
umbral, de modo que un monto mayor mejora de verdad la probabilidad del premio
(ver `rampFor` en `src/lib/rifa.ts`).

Total de inventario: **142 unidades**. Al agotarse se avisa por toast; el
reinicio completo se hace con `R` o manteniendo pulsado el anillo.

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `1`–`8` | Montos sugeridos (500 → 100 000) |
| `Enter` / `Espacio` | Ordeñar |
| `Esc` | Limpiar el monto |
| `R` | Reiniciar rifa y stock |

## Estructura

```
src/
  lib/rifa.ts                  Núcleo puro: catálogo, probabilidades, stock
  scripts/game.ts              Controlador DOM, reels, confeti, HUD
  pages/index.astro            Escena, atmósfera, layout responsive
  components/game/
    Brissa.astro               Mascota SVG con animaciones por data-state
    OrdenarButton.astro        Botón principal
    InvestmentInput.astro      Monto, presets, niveles y probabilidades
    RifaMachine.astro          Reels tipo slot machine
    PrizeReveal.astro          Carta del premio con imagen
    PrizeHistory.astro         Historial y stock restante
public/prices/                 Imágenes de premios
```

## Imágenes de premios

`src/lib/rifa.ts` referencia estas rutas en `public/prices/`:

- `/prices/stickers/sticker1.png`, `sticker2.png`, `sticker3.jpg`, `sticker4.jpg`, `sticker5.png`
- `/prices/pamphlets/brochure.png`
- `/prices/certificates/certificate1.svg`
- `/prices/llaveros/llavero.png`

Los stickers y el llavero usan el arte real de `src/assets/`; el certificado es un
SVG generado. Si una imagen falla al cargar, la app muestra el emoji del nivel en
lugar de dejar la carta en verde vacío.

Para cambiar el arte, reemplaza los archivos conservando los nombres o edita las
rutas en `buildCatalog()`.
