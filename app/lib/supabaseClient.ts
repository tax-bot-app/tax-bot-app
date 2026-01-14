// app/lib/supabaseClient.ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function mustGetEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    // Next.js は NEXT_PUBLIC_* を build 時に埋め込む。
    // ここが落ちる = そのデプロイに env が入ってない。
    throw new Error(`${name} is missing`);
  }
  return v;
}

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = mustGetEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anon = mustGetEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  _client = createClient(url, anon);
  return _client;
}
