import { describe, expect, it } from 'bun:test';
import {
  resolveDeepLinkTab,
  storeFromDeepLinkSearch,
  stripDeepLinkPath,
  stripStoreParam,
  tabFromDeepLinkPath,
  tabFromStartParam,
} from '../deepLink';

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

describe('tabFromStartParam (atlas SHL-6)', () => {
  it('tab_<name> points at that tab', () => {
    expect(tabFromStartParam('tab_sales')).toBe('sales');
    expect(tabFromStartParam(' TAB_Run ')).toBe('run');
  });
  it('invites, unknown tabs and empty values are not tab links', () => {
    expect(tabFromStartParam('inv_abc')).toBeNull();
    expect(tabFromStartParam('tab_nope')).toBeNull();
    expect(tabFromStartParam(undefined)).toBeNull();
  });
});

describe('store in a notification link (DX-APR-7)', () => {
  const id = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  it('reads a store id and ignores anything else', () => {
    expect(storeFromDeepLinkSearch(`?store=${id}`)).toBe(id);
    expect(storeFromDeepLinkSearch(`?x=1&store=${id.toUpperCase()}`)).toBe(id);
    expect(storeFromDeepLinkSearch('?store=central')).toBeNull();
    expect(storeFromDeepLinkSearch('')).toBeNull();
  });
  it('takes the store out of the query and keeps the rest', () => {
    expect(stripStoreParam(`?store=${id}`)).toBe('');
    expect(stripStoreParam(`?devAs=Aziz&store=${id}`)).toBe('?devAs=Aziz');
    expect(stripStoreParam('?devAs=Aziz')).toBe('?devAs=Aziz');
  });
});
