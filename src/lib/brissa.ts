/**
 * Resolución del asset de Brissa.
 *
 * El juego NUNCA depende de que exista un asset oficial: si no hay ninguno,
 * `<Brissa />` dibuja su SVG placeholder. Para sustituirlo basta con:
 *
 *   PUBLIC_BRISSA_ASSET=/brissa.png          # ruta dentro de /public
 *   PUBLIC_BRISSA_ASSET=src/assets/brissa.png
 *
 * o pasar `src` como prop. Ninguna otra parte de la app conoce el asset.
 */

/** URL pública por defecto, resuelta en build time por Astro. */
export function getBrissaAsset(): string | null {
  const raw = import.meta.env.PUBLIC_BRISSA_ASSET;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** Contraseña del modo organización (vacía = deshabilitado). */
export function getOrgPassword(): string | null {
  const raw = import.meta.env.PUBLIC_ORG_PASSWORD;
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

/** Fuerza el modo demo en producción. */
export function isDemoForced(): boolean {
  return import.meta.env.PUBLIC_FORCE_DEMO === '1';
}

export function isDev(): boolean {
  return import.meta.env.DEV === true;
}
