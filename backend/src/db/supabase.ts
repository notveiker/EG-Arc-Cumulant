import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// Importing config pulls in dotenv (it loads the shared repo-root .env), so by the
// time this module evaluates, process.env is populated even when something imports
// db/supabase before anything else.
import "../config.js";

/**
 * Supabase persistence for Cumulant (mirrors what Cumulant did) — but it degrades
 * gracefully. The Cumulant backend must boot and serve on-chain + Polymarket data
 * even with no database configured.
 *
 * If SUPABASE_URL and a service key (SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY)
 * are both present, we create a real service-role client. Otherwise `supabase` is
 * `null` and `supabaseEnabled` is `false`; every query helper in db/queries.ts
 * early-returns a safe empty value, recording nothing.
 */

/** Empty/whitespace env values are treated as unset. */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

const SUPABASE_URL = env("SUPABASE_URL");
const SUPABASE_SERVICE_KEY =
  env("SUPABASE_SERVICE_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY");

export const supabaseEnabled: boolean = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_KEY,
);

export const supabase: SupabaseClient | null = supabaseEnabled
  ? createClient(SUPABASE_URL as string, SUPABASE_SERVICE_KEY as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

if (!supabaseEnabled) {
  console.warn(
    "[supabase] SUPABASE_URL / SUPABASE_SERVICE_KEY not set — persistence disabled (queries are safe no-ops).",
  );
}
