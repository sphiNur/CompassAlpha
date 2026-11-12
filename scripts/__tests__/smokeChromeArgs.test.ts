import { describe, expect, test } from 'bun:test';
import { smokeChromeArgs } from '../lib/smokeHarness.ts';

describe('smokeChromeArgs (SMOKE_IPV4)', () => {
  const resolve4 = async (host: string) => (host === 'app.example.test' ? '192.0.2.10' : '');

  test('off by default: no extra Chrome flags', async () => {
    expect(await smokeChromeArgs({ COMPASS_BASE: 'https://app.example.test' }, resolve4)).toEqual(
      [],
    );
  });

  test('SMOKE_IPV4=1 maps the target host to its IPv4 address and turns QUIC off', async () => {
    expect(
      await smokeChromeArgs(
        { SMOKE_IPV4: '1', COMPASS_BASE: 'https://app.example.test/' },
        resolve4,
      ),
    ).toEqual(['--disable-quic', '--host-resolver-rules=MAP app.example.test 192.0.2.10']);
  });

  test('without a target there is nothing to map', async () => {
    expect(await smokeChromeArgs({ SMOKE_IPV4: '1' }, resolve4)).toEqual([]);
  });
});
