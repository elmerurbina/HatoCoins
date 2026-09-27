/**
 * Cliente de Supabase.
 *
 * Se crea una sola vez, de forma perezosa y sólo en el navegador: durante el
 * build/SSR de Astro no hay `window` y no debe intentarse ninguna conexión.
 *
 * La configuración llega por variables `PUBLIC_*`, que Vite sustituye
 * literalmente en el bundle. Importante: la `publishable key` es PÚBLICA (así
 * funciona RLS), no es un secreto. La clave secreta es la `service_role` y
 * jamás debe llegar aquí.
 *
 * Ojo con el prefijo: Astro sólo expone al bundle las variables que empiezan por
 * `PUBLIC_`. Un `NEXT_PUBLIC_…` (que es la convención de Next.js) llegaría al
 * cliente como `undefined` sin avisar, por eso aquí se lee `PUBLIC_SUPABASE_*`.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * `import.meta.env` no existe fuera de Vite (p. ej. en el bundle de test bajo
 * Node), así que se lee con acceso opcional y no como propiedad directa.
 */
const ENV = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const URL = ENV.PUBLIC_SUPABASE_URL;
// Se acepta también el nombre antiguo por si alguien tiene un `.env` previo:
// ambas son la misma credencial pública.
const KEY = ENV.PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ENV.PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

/**
 * Devuelve el motivo por el que Supabase no está operativo, o `null` si todo
 * está bien. Se evalúa sin lanza: la app debe poder mostrar el aviso de
 * configuración en lugar de romperse al arrancar.
 */
export function supabaseConfigError(): string | null {
  if (typeof window === 'undefined') return 'No hay navegador.';
  if (!URL) return 'Falta PUBLIC_SUPABASE_URL';
  if (!KEY) return 'Falta PUBLIC_SUPABASE_PUBLISHABLE_KEY';
  if (!/^https?:\/\//i.test(URL)) return 'PUBLIC_SUPABASE_URL no es una URL válida';
  return null;
}

export function isSupabaseConfigured(): boolean {
  return supabaseConfigError() === null;
}

/**
 * Cliente único. Lanza si faltan credenciales: quien lo llama debe haber
 * comprobado `isSupabaseConfigured()` antes.
 */
export function getSupabase(): SupabaseClient {
  const error = supabaseConfigError();
  if (error) throw new Error(error);
  if (!client) {
    client = createClient(URL as string, KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }
  return client;
}
