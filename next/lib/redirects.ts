import { SITE_URL } from '@/lib/shared/site-url';

/**
 * Strapi-managed redirects, resolved at request time from `proxy.ts`.
 *
 * The SEO team edits the `Redirection` collection in Strapi and publishes rows.
 * No rebuild is needed: the list is cached in module memory for a short TTL so
 * a normal request never waits on Strapi more than once per window.
 */

const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 2_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const MAX_HOPS = 10;

const HTTP_URL = /^https?:\/\//i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const INVALID_CHARS = /[\u0000-\u001F\u007F\s?#]/;

export type RedirectMap = Map<string, string>;

export interface RedirectMapResult {
  map: RedirectMap;
  skipped: number;
}

export interface RedirectMatch {
  /** Locale taken from the incoming path, or null for an unprefixed path. */
  locale: string | null;
  /** Normalized destination path, without a locale prefix. */
  destination: string;
}

function siteOrigin(): string {
  return new URL(SITE_URL).origin;
}

/**
 * Turns any path-like value into a canonical, locale-less path:
 * leading slash, no query/hash, no trailing slash, decoded.
 */
export function normalizePath(value: string): string | null {
  let path = value.trim();
  if (!path) return null;

  // Redirects match paths only. Query strings are forwarded from the request.
  path = path.split(/[?#]/, 1)[0];

  if (!path.startsWith('/')) path = `/${path}`;

  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep malformed percent-encoding as-is; it simply will not match.
  }

  // Check after decoding: `%5C` becomes `\`, which URL parsers turn into `/`,
  // and `%2F%2F` becomes a protocol-relative path. Either would be an open
  // redirect if passed to `new URL()`.
  if (path.startsWith('//') || path.includes('\\')) return null;

  path = path.replace(/\/{2,}/g, '/');
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  path = path.replace(/\/+$/, '') || '/';

  return INVALID_CHARS.test(path) ? null : path;
}

export function stripLocalePrefix(
  path: string,
  locales: readonly string[]
): string {
  for (const locale of locales) {
    if (path === `/${locale}`) return '/';
    if (path.startsWith(`/${locale}/`)) return path.slice(locale.length + 1);
  }

  return path;
}

/**
 * A source accepts any absolute URL (only the path matters). A destination
 * accepts relative paths or absolute URLs on the site's own origin; external
 * destinations are rejected so this cannot become an open redirect.
 */
function normalizeStoredPath(
  value: unknown,
  locales: readonly string[],
  isSource: boolean
): string | null {
  if (typeof value !== 'string') return null;

  let path = value.trim();
  if (!path || path.includes('\\') || path.startsWith('//')) return null;

  if (HTTP_URL.test(path)) {
    try {
      const url = new URL(path);
      if (!isSource && url.origin !== siteOrigin()) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (SCHEME.test(path)) {
    // mailto:, tel:, javascript:, ... — internal paths only.
    return null;
  }

  const normalized = normalizePath(path);
  return normalized ? stripLocalePrefix(normalized, locales) : null;
}

function resolveChain(source: string, map: RedirectMap): string | null {
  const seen = new Set([source]);
  let current = source;

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const next = map.get(current);
    if (!next) return current === source ? null : current;
    if (next === current) return current;
    if (seen.has(next)) return null;

    seen.add(next);
    current = next;
  }

  return null;
}

export function buildRedirectMap(
  entries: readonly unknown[],
  locales: readonly string[]
): RedirectMapResult {
  // The REST call already sorts, but keep the newest row winning even if the
  // API ignores the sort parameter.
  const sorted = [...entries].sort((left, right) => {
    const a = (left as { updatedAt?: unknown } | null)?.updatedAt;
    const b = (right as { updatedAt?: unknown } | null)?.updatedAt;
    return String(b ?? '').localeCompare(String(a ?? ''));
  });

  const raw: RedirectMap = new Map();
  let skipped = 0;

  for (const entry of sorted) {
    const record = entry as { source?: unknown; destination?: unknown };
    const source = normalizeStoredPath(record?.source, locales, true);
    const destination = normalizeStoredPath(
      record?.destination,
      locales,
      false
    );

    if (!source || !destination || source === '/') {
      skipped += 1;
      continue;
    }

    // First (newest) row wins when the same source is published twice.
    if (!raw.has(source)) raw.set(source, destination);
  }

  const map: RedirectMap = new Map();

  for (const source of raw.keys()) {
    const destination = resolveChain(source, raw);
    if (!destination) {
      skipped += 1;
      continue;
    }

    map.set(source, destination);
  }

  // Canonicalize the bare form of every destination: /faq -> /fa/faq.
  for (const destination of new Set(map.values())) {
    if (destination !== '/' && !map.has(destination)) {
      map.set(destination, destination);
    }
  }

  return { map, skipped };
}

export function findRedirect(
  pathname: string,
  locales: readonly string[],
  map: RedirectMap
): RedirectMatch | null {
  const path = normalizePath(pathname);
  if (!path) return null;

  const locale =
    locales.find(
      (candidate) =>
        path === `/${candidate}` || path.startsWith(`/${candidate}/`)
    ) ?? null;

  const destination = map.get(locale ? stripLocalePrefix(path, locales) : path);

  return destination ? { locale, destination } : null;
}

let cache: { at: number; map: RedirectMap } | null = null;
let inFlight: Promise<RedirectMap> | null = null;

function strapiBaseUrl(): string | null {
  const raw =
    process.env.STRAPI_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL;
  return raw ? raw.replace(/\/+$/, '') : null;
}

async function fetchRedirectMap(
  locales: readonly string[]
): Promise<RedirectMap> {
  const baseUrl = strapiBaseUrl();
  if (!baseUrl) return new Map();

  const entries: unknown[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`${baseUrl}/api/redirections`);
    url.search = new URLSearchParams({
      sort: 'updatedAt:desc',
      'pagination[page]': String(page),
      'pagination[pageSize]': String(PAGE_SIZE),
    }).toString();

    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`Strapi responded with ${response.status}`);
    }

    const payload = (await response.json()) as {
      data?: unknown[];
      meta?: { pagination?: { pageCount?: number } };
    };
    if (!Array.isArray(payload?.data)) {
      throw new Error('Strapi returned an unexpected response shape');
    }

    entries.push(...payload.data);

    const pageCount = payload.meta?.pagination?.pageCount;
    if (
      (typeof pageCount === 'number' && page >= pageCount) ||
      (typeof pageCount !== 'number' && payload.data.length < PAGE_SIZE)
    ) {
      break;
    }
  }

  const { map, skipped } = buildRedirectMap(entries, locales);

  if (skipped > 0) {
    console.warn(
      `[redirects] ignored ${skipped} invalid or cyclic redirection row(s)`
    );
  }

  return map;
}

export async function loadRedirectMap(
  locales: readonly string[]
): Promise<RedirectMap> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  if (inFlight) return inFlight;

  inFlight = fetchRedirectMap(locales)
    .then((map) => {
      cache = { at: Date.now(), map };
      return map;
    })
    .catch((error) => {
      const map = cache?.map ?? new Map<string, string>();
      // Back off for a full TTL instead of retrying on every request.
      cache = { at: Date.now(), map };
      console.warn(
        `[redirects] could not load from Strapi: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return map;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
