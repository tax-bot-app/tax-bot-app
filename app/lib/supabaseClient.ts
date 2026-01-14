import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !url.trim()) throw new Error("NEXT_PUBLIC_SUPABASE_URL is missing");
  if (!anon || !anon.trim()) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is missing");

  _client = createClient(url, anon);
  return _client;
}
