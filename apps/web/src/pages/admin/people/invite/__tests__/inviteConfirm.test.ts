import { describe, expect, test } from 'bun:test';
import { existingMemberPrompt } from '../inviteConfirm';

const base = {
  displayName: 'Leo Park',
  roleName: 'Store staff',
  orgWide: false,
  storeNames: ['Central'],
  separator: ', ',
};

describe('the question before adding someone already here (UX-24)', () => {
  test('names them, the role and the store', () => {
    expect(existingMemberPrompt(base)).toEqual({
      title: { key: 'admin.invite.existing.title', params: { name: 'Leo Park' } },
      body: {
        key: 'admin.invite.existing.body',
        params: { role: 'Store staff', store: 'Central' },
      },
    });
  });

  test('several stores are listed with the language separator', () => {
    const { body } = existingMemberPrompt({
      ...base,
      storeNames: ['Central', 'Airport'],
      separator: '、',
    });
    expect(body.params).toEqual({ role: 'Store staff', store: 'Central、Airport' });
  });

  test('no name to show (not visible to the inviter, or blank): "this person"', () => {
    expect(existingMemberPrompt({ ...base, displayName: null }).title).toEqual({
      key: 'admin.invite.existing.titleNoName',
      params: {},
    });
    expect(existingMemberPrompt({ ...base, displayName: '  ' }).title.key).toBe(
      'admin.invite.existing.titleNoName',
    );
  });

  test('an org-tier role is for the whole workspace, not the stores', () => {
    expect(existingMemberPrompt({ ...base, roleName: 'Admin', orgWide: true }).body).toEqual({
      key: 'admin.invite.existing.bodyOrgWide',
      params: { role: 'Admin' },
    });
  });
});
