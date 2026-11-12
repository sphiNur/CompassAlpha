/**
 * Review ADM2-34 (2026-11-12): a purge preview counts rows by table and the
 * web shows them by kind (PURGE_KIND_BY_TABLE in @compass/contracts/limits).
 * A table a purge deletes from that the map lacks would show as "Other";
 * this fails instead, for each of the four purges. No database needed: the
 * plans are built, not run.
 */
import { describe, expect, test } from 'bun:test';
import { PURGE_KIND_BY_TABLE } from '@compass/contracts/limits';
import {
  datePurge,
  purgeKey,
  runPurge,
  sessionPurge,
  workspacePurge,
} from '../services/purgePlans';

const ORG = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';

const PLANS = {
  workspace: workspacePurge(ORG),
  date: datePurge(ORG, [ID], [ID]),
  order: sessionPurge(ORG, ID),
  run: runPurge(ORG, ID, [ID]),
};

describe('every table a purge deletes from has a kind (ADM2-34)', () => {
  for (const [name, steps] of Object.entries(PLANS)) {
    test(name, () => {
      const unknown = steps
        .map((step) => purgeKey(step.table))
        .filter((key) => !(key in PURGE_KIND_BY_TABLE));
      expect(unknown).toEqual([]);
    });
  }
});
