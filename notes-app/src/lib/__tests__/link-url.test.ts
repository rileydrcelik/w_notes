import { describe, expect, it } from 'vitest';

import { isOpenableLinkUrl, normalizeLinkUrl } from '@/lib/link-url';

describe('normalizeLinkUrl', () => {
  it('keeps an address that already has an allowed scheme', () => {
    expect(normalizeLinkUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(normalizeLinkUrl('http://example.com')).toBe('http://example.com');
    expect(normalizeLinkUrl('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(normalizeLinkUrl('tel:5551234')).toBe('tel:5551234');
  });

  it('gives a bare host https, so it is not stored as a relative link', () => {
    expect(normalizeLinkUrl('example.com')).toBe('https://example.com');
    expect(normalizeLinkUrl('  example.com/path  ')).toBe('https://example.com/path');
    expect(normalizeLinkUrl('//cdn.example.com/x')).toBe('https://cdn.example.com/x');
  });

  it('reads host:port as a host, not a scheme', () => {
    expect(normalizeLinkUrl('localhost:3000')).toBe('https://localhost:3000');
    expect(normalizeLinkUrl('localhost:8081/notes')).toBe('https://localhost:8081/notes');
  });

  it('turns a bare email address into mailto', () => {
    expect(normalizeLinkUrl('someone@example.com')).toBe('mailto:someone@example.com');
  });

  it('refuses schemes that would run or read something when clicked', () => {
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('JavaScript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('data:text/html,<script>x</script>')).toBeNull();
    expect(normalizeLinkUrl('file:///etc/passwd')).toBeNull();
  });

  it('refuses empty or spaced input', () => {
    expect(normalizeLinkUrl('')).toBeNull();
    expect(normalizeLinkUrl('   ')).toBeNull();
    expect(normalizeLinkUrl('not a url')).toBeNull();
  });
});

describe('isOpenableLinkUrl', () => {
  it('opens only allowed schemes', () => {
    expect(isOpenableLinkUrl('https://example.com')).toBe(true);
    expect(isOpenableLinkUrl('mailto:a@b.co')).toBe(true);
    expect(isOpenableLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableLinkUrl('/relative')).toBe(false);
    expect(isOpenableLinkUrl(null)).toBe(false);
    expect(isOpenableLinkUrl(undefined)).toBe(false);
  });
});
