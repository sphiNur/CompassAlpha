import { z } from 'zod';
import { DateStringSchema, UuidSchema } from './common';

/** Attendance (2026-11-05). See packages/domain/src/attendance. */

export const AttendanceTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** A random id the phone keeps; 16–128 printable characters. */
export const AttendanceDeviceIdSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const AttendanceLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  /** Metres, as the phone reports it. */
  accuracy: z.number().min(0).max(100_000),
});

export const AttendanceMeInputSchema = z.object({
  deviceId: AttendanceDeviceIdSchema.optional(),
});

export const AttendancePunchInputSchema = z.object({
  storeId: UuidSchema,
  kind: z.enum(['in', 'out']),
  deviceId: AttendanceDeviceIdSchema,
  platform: z.string().max(32).optional(),
  location: AttendanceLocationSchema.nullable().optional(),
});

const reason = z.string().trim().min(1).max(300);

export const AttendanceSheetInputSchema = z
  .object({
    storeId: UuidSchema,
    from: DateStringSchema,
    to: DateStringSchema,
  })
  .refine((v) => v.from <= v.to, { message: 'attendance.errors.badRange' });

export const AttendanceShiftSaveInputSchema = z.object({
  storeId: UuidSchema,
  /** Present to edit an existing shift. */
  shiftId: UuidSchema.optional(),
  memberId: UuidSchema,
  date: DateStringSchema,
  start: AttendanceTimeSchema,
  /** At or before `start` means the next day. */
  end: AttendanceTimeSchema,
  note: z.string().trim().max(200).optional(),
});

export const AttendanceShiftDeleteInputSchema = z.object({
  storeId: UuidSchema,
  shiftId: UuidSchema,
});

export const AttendanceCopyWeekInputSchema = z.object({
  storeId: UuidSchema,
  /** Monday of the week to copy from. */
  fromWeek: DateStringSchema,
  toWeek: DateStringSchema,
});

export const AttendanceManualPunchInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
  kind: z.enum(['in', 'out']),
  date: DateStringSchema,
  time: AttendanceTimeSchema,
  reason,
});

export const AttendanceVoidPunchInputSchema = z.object({
  storeId: UuidSchema,
  punchId: UuidSchema,
  reason,
});

export const AttendanceMemberSetInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
  enabled: z.boolean(),
});

export const AttendanceResetDeviceInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
});

export const AttendancePolicyGetInputSchema = z.object({ storeId: UuidSchema });

export const AttendancePolicySaveInputSchema = z
  .object({
    storeId: UuidSchema,
    requireDevice: z.boolean(),
    requireGeo: z.boolean(),
    geo: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        radiusM: z.number().int().min(20).max(5000),
      })
      .nullable(),
    requireIp: z.boolean(),
    /** Addresses or CIDR ranges (`203.0.113.7`, `203.0.113.0/24`). */
    allowedIps: z.array(z.string().trim().min(2).max(64)).max(20),
    graceMinutes: z.number().int().min(0).max(120),
  })
  .refine((v) => !v.requireGeo || v.geo !== null, { message: 'attendance.errors.geoMissing' })
  .refine((v) => !v.requireIp || v.allowedIps.length > 0, {
    message: 'attendance.errors.ipMissing',
  });

export type AttendancePunchInput = z.infer<typeof AttendancePunchInputSchema>;
export type AttendancePolicySaveInput = z.infer<typeof AttendancePolicySaveInputSchema>;
