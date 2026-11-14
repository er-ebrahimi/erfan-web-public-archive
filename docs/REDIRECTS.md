# Redirects

Manual 301 redirects managed by the SEO/content team in Strapi. No rebuild or
redeploy is needed.

## Add a redirect

1. Strapi admin → **Content Manager** → **Redirects**.
2. **Create new entry**.
3. **Source**: the old path, for example `/bathroomdesign`.
4. **Destination**: the new path, for example `/bathroom-design`.
5. **Save**, then **Publish**.

A row that is only saved, or modified after publishing, is a draft and does
**not** redirect. The Content Manager shows the draft/published state.

Changes reach the site within about 30 seconds.

Both forms work:

| Request                    | Result                          |
| -------------------------- | ------------------------------- |
| `/fa/bathroomdesign`       | `301 /fa/bathroom-design`       |
| `/bathroomdesign`          | `301 /fa/bathroom-design`       |
| `/fa/bathroomdesign?utm=x` | `301 /fa/bathroom-design?utm=x` |

A trailing slash is normalized by Next first (`308 /fa/bathroomdesign`), and the
`301` applies on the next request. Two hops, same destination.

Destinations are canonicalized too: if a row points to `/faq`, then `/faq`
redirects to `/fa/faq` and `/fa/faq` renders normally (no loop). This covers
links that were shared without the `/fa` prefix.

## How it works

- `next/proxy.ts` checks the redirect map before the page renders and returns a
  `301` with `Location`.
- `next/lib/redirects.ts` fetches published rows from
  `${STRAPI_INTERNAL_URL}/api/redirections` (fallback
  `NEXT_PUBLIC_API_URL`) and caches them in memory for 30 seconds.
- If Strapi is slow or down, the last good list stays in use. The site itself is
  unaffected.
- The old build-time fetch was removed from `next/next.config.ts`. Only the
  hardcoded legacy category redirects remain there; they run before CMS
  redirects and win on a collision.

## Rules and limits

- **Internal destinations only.** External URLs (`https://other.com`,
  `mailto:`, ...) are ignored.
- **Paths only.** Query strings and hashes in the Strapi fields are dropped.
  The incoming request's query string is forwarded to the destination.
- **Exact match.** No wildcards or prefix matching. `/old` does not affect
  `/old/child`.
- **Case-sensitive.** `/Faq` does not match `/faq`.
- Trailing slashes are normalized by Next before the proxy runs, so an old URL
  with a slash costs one extra `308` hop. A leading `/fa` (or any active locale)
  is optional in both fields; a full same-site URL also works.
- Several old paths can point to the same destination.
- Every destination is also reachable without the locale prefix: `/faq` →
  `301 /fa/faq`. The prefixed URL itself renders normally.
- A redirect **wins over a live page** with the same path. That page becomes
  unreachable until the row is unpublished.
- Chains are collapsed to one hop (`/a → /b → /c` becomes `/a → /c`). Cycles
  and chains longer than 10 are ignored and logged.
- Destination existence is not checked. A 301 can point at a 404.
- No per-locale rules; a published row applies to every active locale.
- **301 is cached permanently by browsers and CDNs.** Stage the row as a draft,
  publish, test, and only then leave it live. If WCDN caches the old response,
  purge that URL after changing the destination.

## Troubleshooting

| Symptom                    | Check                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------- |
| Nothing happens            | Is the row **published**? A modified row is a draft.                                                |
| Still nothing after 30s    | `curl -I https://studioarman.com/fa/old-path`                                                       |
| `403` from Strapi          | Settings → Users & Permissions → Roles → **Public** must have `find` on **Redirects**               |
| Works locally, not in prod | `STRAPI_INTERNAL_URL` must be reachable from the Next container                                     |
| Row ignored                | Container logs contain `[redirects] ignored ... row(s)` or `[redirects] could not load from Strapi` |
| Redirect stopped           | The row was unpublished or deleted; both take effect within 30s                                     |

## For developers

- Logic: `next/lib/redirects.ts`.
- Request hook: `next/proxy.ts`.
- Unit tests: `next/lib/__tests__/redirects.test.ts` (`cd next && yarn test:unit`).
- TTL and timeout are constants at the top of `next/lib/redirects.ts`.
