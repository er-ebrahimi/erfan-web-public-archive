import { describe, expect, it } from 'vitest';

import {
  buildRedirectMap,
  findRedirect,
  normalizePath,
  stripLocalePrefix,
} from '../redirects';

const locales = ['fa'];

function mapFrom(entries: Array<Record<string, unknown>>) {
  return buildRedirectMap(entries, locales).map;
}

describe('normalizePath', () => {
  it('adds a leading slash and removes trailing slashes', () => {
    expect(normalizePath('bathroomdesign')).toBe('/bathroomdesign');
    expect(normalizePath('/bathroomdesign/')).toBe('/bathroomdesign');
  });

  it('drops query strings and hashes', () => {
    expect(normalizePath('/old?x=1')).toBe('/old');
    expect(normalizePath('/old#top')).toBe('/old');
  });

  it('keeps the root path', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('rejects protocol-relative and malformed paths', () => {
    expect(normalizePath('//evil.example')).toBeNull();
    expect(normalizePath('/old/../new')).toBeNull();
    expect(normalizePath('/old page')).toBeNull();
  });

  it('rejects encoded open-redirect payloads after decoding', () => {
    expect(normalizePath('/%5C%5Cevil.example')).toBeNull();
    expect(normalizePath('/%2F%2Fevil.example')).toBeNull();
  });

  it('rejects encoded query separators after decoding', () => {
    expect(normalizePath('/old%3Fx')).toBeNull();
    expect(normalizePath('/old%23x')).toBeNull();
  });

  it('decodes percent-encoded slugs', () => {
    expect(normalizePath(encodeURI('/کابینت'))).toBe('/کابینت');
  });
});

describe('stripLocalePrefix', () => {
  it('removes a known locale only', () => {
    expect(stripLocalePrefix('/fa/old', locales)).toBe('/old');
    expect(stripLocalePrefix('/farsi/old', locales)).toBe('/farsi/old');
  });
});

describe('buildRedirectMap', () => {
  it('normalizes source and destination', () => {
    const map = mapFrom([
      { source: 'bathroomdesign', destination: '/fa/bathroom-design/' },
    ]);

    expect(map.get('/bathroomdesign')).toBe('/bathroom-design');
  });

  it('keeps the newest duplicate source', () => {
    const map = mapFrom([
      {
        source: '/old',
        destination: '/newer',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        source: '/old',
        destination: '/older',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    expect(map.get('/old')).toBe('/newer');
  });

  it('flattens chains to one hop', () => {
    const map = mapFrom([
      { source: '/a', destination: '/b' },
      { source: '/b', destination: '/c' },
    ]);

    expect(map.get('/a')).toBe('/c');
    expect(map.get('/b')).toBe('/c');
    expect(map.get('/c')).toBe('/c');
  });

  it('canonicalizes the bare form of destinations', () => {
    const map = mapFrom([{ source: '/old', destination: '/faq' }]);

    expect(map.get('/old')).toBe('/faq');
    expect(map.get('/faq')).toBe('/faq');
  });

  it('keeps an explicit localized self-mapping as a canonicalization rule', () => {
    const map = mapFrom([{ source: '/faq', destination: '/fa/faq' }]);

    expect(map.get('/faq')).toBe('/faq');
  });

  it('drops cycles entirely', () => {
    const result = buildRedirectMap(
      [
        { source: '/a', destination: '/b' },
        { source: '/b', destination: '/a' },
      ],
      locales
    );

    expect(result.map.size).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
  });

  it('rejects external destinations and homepage sources', () => {
    const map = mapFrom([
      { source: '/old', destination: 'https://evil.example' },
      { source: '/', destination: '/new' },
    ]);

    expect(map.size).toBe(0);
  });

  it('rejects encoded protocol-relative and backslash destinations', () => {
    const map = mapFrom([
      { source: '/a', destination: '/%5C%5Cevil.example' },
      { source: '/b', destination: '/%2F%2Fevil.example' },
    ]);

    expect(map.size).toBe(0);
  });

  it('accepts a full source URL and a same-origin destination URL', () => {
    const map = mapFrom([
      {
        source: 'https://studioarman.com/bathroomdesign',
        destination: 'http://localhost:3000/bathroom-design',
      },
    ]);

    expect(map.get('/bathroomdesign')).toBe('/bathroom-design');
  });
});

describe('findRedirect', () => {
  const map = mapFrom([{ source: '/old', destination: '/new' }]);

  it('matches locale-prefixed paths and reports the locale', () => {
    expect(findRedirect('/fa/old', locales, map)).toEqual({
      locale: 'fa',
      destination: '/new',
    });
  });

  it('matches unprefixed paths', () => {
    expect(findRedirect('/old', locales, map)).toEqual({
      locale: null,
      destination: '/new',
    });
  });

  it('ignores unknown paths', () => {
    expect(findRedirect('/fa/other', locales, map)).toBeNull();
  });
});
