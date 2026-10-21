import { describe, expect, it } from 'bun:test';
import { resolveDeepLinkTab, stripDeepLinkPath, tabFromDeepLinkPath } from '../deepLink';

describe('tabFromDeepLinkPath', () => {
  it('maps the notification paths to their tabs', () => {
    expect(tabFromDeepLinkPath('/approve')).toBe('approve');
    expect(tabFromDeepLinkPath('/order')).toBe('order');
    expect(tabFromDeepLinkPath('/run')).toBe('run');
    expect(tabFromDeepLinkPath('/confirm')).toBe('confirm');
  });

  it('tolerates a trailing slash, case and a sub-path deployment', () => {
    expect(tabFromDeepLinkPath('/approve/')).toBe('approve');
    expect(tabFromDeepLinkPath('/Confirm')).toBe('confirm');
    expect(tabFromDeepLinkPath('/app/run')).toBe('run');
  });

  it('ignores the root and unknown paths', () => {
    expect(tabFromDeepLinkPath('/')).toBeNull();
    expect(tabFromDeepLinkPath('')).toBeNull();
    expect(tabFromDeepLinkPath('/index.html')).toBeNull();
    expect(tabFromDeepLinkPath('/approvals')).toBeNull();
  });
});

describe('stripDeepLinkPath', () => {
  it('drops the deep-link segment only', () => {
    expect(stripDeepLinkPath('/approve')).toBe('/');
    expect(stripDeepLinkPath('/approve/')).toBe('/');
    expect(stripDeepLinkPath('/app/run')).toBe('/app/');
    expect(stripDeepLinkPath('/index.html')).toBe('/index.html');
    expect(stripDeepLinkPath('/')).toBe('/');
  });
});

describe('resolveDeepLinkTab', () => {
  it('returns the tab only when the user can see it', () => {
    expect(resolveDeepLinkTab('/approve', ['order', 'approve'])).toBe('approve');
    expect(resolveDeepLinkTab('/approve', ['order'])).toBeNull();
    expect(resolveDeepLinkTab('/', ['order'])).toBeNull();
  });
});
