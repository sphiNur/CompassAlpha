import { z } from 'zod';
import { UuidSchema } from './common';

/** `nav.counts`: the badges of the bottom navigation. */
export const NavCountsInputSchema = z.object({
  /** The store chosen in the header; omitted for 「全部门店」. */
  storeId: UuidSchema.optional(),
});
