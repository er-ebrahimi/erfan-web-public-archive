import createMiddleware from 'next-intl/middleware';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { routing } from './i18n/routing';
import { notFoundMarkdown } from '@/lib/not-found-markdown';
import { findRedirect, loadRedirectMap, normalizePath } from '@/lib/redirects';
import { SITE_URL } from '@/lib/shared/site-url';

const intlMiddleware = createMiddleware(routing);

function markdownNotFoundResponse(): NextResponse {
  return new NextResponse(notFoundMarkdown(), {
    status: 404,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      Vary: 'Accept, Accept-Encoding',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

export default async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (request.method === 'GET' || request.method === 'HEAD') {
    const redirects = await loadRedirectMap(routing.locales);
    const match = findRedirect(pathname, routing.locales, redirects);

    if (match) {
      const locale = match.locale ?? routing.defaultLocale;
      const target = `/${locale}${
        match.destination === '/' ? '' : match.destination
      }`;

      // A canonicalization entry (/faq -> /fa/faq) must not loop on the
      // already-prefixed URL.
      if (target !== normalizePath(pathname)) {
        const url = new URL(target, SITE_URL);
        url.search = request.nextUrl.search;

        return NextResponse.redirect(url, 301);
      }
    }
  }

  if (pathname === '/') {
    request.nextUrl.pathname = `/${routing.defaultLocale}`;
    return NextResponse.rewrite(request.nextUrl);
  }

  const hasLocalePrefix = routing.locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
  );

  if (!hasLocalePrefix) {
    if ((request.headers.get('accept') || '').includes('text/markdown')) {
      return markdownNotFoundResponse();
    }
    // Internal prefix guarantees the rewrite matches no real route and renders
    // the server-side 404; the browser URL stays unchanged.
    request.nextUrl.pathname = `/${routing.defaultLocale}/_404${pathname}`;
    return NextResponse.rewrite(request.nextUrl);
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon-sets|[^/]+/favicon-sets|robots.txt|sitemap.xml|llms.txt|.*\\.(?:svg|png|webp|jpg|jpeg|gif|ico|ttf|woff2?|mp4|webm)$).*)',
  ],
};
