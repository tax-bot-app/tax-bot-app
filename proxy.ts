import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ===== 0) allowlist（常に通す：ループ防止＆ログイン導線確保） =====
  const ALWAYS_ALLOW_PREFIXES = ["/maintenance", "/login", "/_next"];
  const AUTH_CALLBACK_PREFIXES = [
    "/auth/v1",
    "/auth/callback",
    "/api/auth/callback",
    "/api/auth/confirm",
    "/auth/v1/callback",
    "/api/auth",
  ];
  const STATIC_EXT_RE =
    /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff|woff2)$/i;

  const isAllowed =
    ALWAYS_ALLOW_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    ) ||
    AUTH_CALLBACK_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(p + "/")
    ) ||
    pathname === "/favicon.ico" ||
    STATIC_EXT_RE.test(pathname);

  if (isAllowed) {
    return NextResponse.next();
  }

  // ===== 1) Supabase SSR（セッション同期維持） =====
  let res = NextResponse.next();

res.headers.set("x-mw-hit", "1");
res.headers.set("x-maint-mode", (process.env.MAINTENANCE_MODE ?? "off").toLowerCase());

  const cookiesApplied: Array<{ name: string; value: string; options: any }> =
    [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, options);
            cookiesApplied.push({ name, value, options });
          });
        },
      },
    }
  );

  // セッション同期（更新が走る）
  const { data, error } = await supabase.auth.getUser();
  const isLoggedIn = Boolean(data?.user) && !error;

  // ===== 2) Maintenance 判定（off|soft|hard） =====
  const mode = (process.env.MAINTENANCE_MODE ?? "off").toLowerCase();
  if (mode === "off") return res;

  // hard：全員 /maintenance
  // soft：ログイン済みだけ通す（未ログインは /maintenance）
  const mustRedirect = mode === "hard" || (mode === "soft" && !isLoggedIn);
  if (!mustRedirect) return res;

  const url = req.nextUrl.clone();
  url.pathname = "/maintenance";
  const r = NextResponse.redirect(url);

  // getUser() がセットした cookie を redirect にも引き継ぐ
  cookiesApplied.forEach(({ name, value, options }) =>
    r.cookies.set(name, value, options)
  );

  return r;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};