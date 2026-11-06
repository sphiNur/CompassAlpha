import { z } from 'zod';
import { DateStringSchema, LocaleSchema, UuidSchema } from './common';
import { SettlementMoneySchema } from './settlement';

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

/** A base64 JPEG of at most ~600 KB (the client sends ~720 px, ~100 KB). */
export const AttendancePhotoSchema = z
  .string()
  .max(820_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const AttendancePunchInputSchema = z.object({
  storeId: UuidSchema,
  /** Omitted with `identify`: the server knows the colleague's next punch. */
  kind: z.enum(['in', 'out']).optional(),
  deviceId: AttendanceDeviceIdSchema,
  platform: z.string().max(32).optional(),
  location: AttendanceLocationSchema.nullable().optional(),
  /** Why a clock-out runs well past the shift; the server asks for it. */
  overtimeReason: z.string().trim().min(1).max(300).optional(),
  /** Taken on the spot when the store asks for photos: base64 JPEGs. */
  photos: z
    .object({ face: AttendancePhotoSchema, scene: AttendancePhotoSchema.optional() })
    .optional(),
  /**
   * Liveness (2026-11-06): the challenge from `livenessChallenge` and the
   * two head-turn frames; `photos.face` is the straight-on frame.
   */
  liveness: z
    .object({
      token: z.string().min(20).max(2000),
      /** The turn frames, when the challenge asked for turns. */
      left: AttendancePhotoSchema.optional(),
      right: AttendancePhotoSchema.optional(),
    })
    .optional(),
  /** After two failed liveness tries: clock anyway, flagged for the managers. */
  acceptLivenessFail: z.boolean().optional(),
  /** Clocking on a colleague's phone: whose punch this is (same store). */
  forMemberId: UuidSchema.optional(),
  /** Clocking on a colleague's phone: the server finds who it is by the face. */
  identify: z.boolean().optional(),
});

export const AttendanceLivenessChallengeInputSchema = z.object({
  storeId: UuidSchema,
  forMemberId: UuidSchema.optional(),
  identify: z.boolean().optional(),
  /** This phone and place: a new phone or an unknown place asks for turns. */
  deviceId: AttendanceDeviceIdSchema.optional(),
  location: AttendanceLocationSchema.nullable().optional(),
  /** Always ask for turns (the server said a punch needs them). */
  force: z.boolean().optional(),
});

export const AttendanceReviewQueueInputSchema = z.object({ storeId: UuidSchema });

export const AttendanceReviewPunchInputSchema = z.object({
  storeId: UuidSchema,
  punchId: UuidSchema,
});

export const AttendanceFaceConsentInputSchema = z.object({
  version: z.number().int().min(1).max(1000),
});

export const AttendanceColleaguesInputSchema = z.object({ storeId: UuidSchema });

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
    graceMinutes: z.number().int().min(0).max(120),
    overtimeAfterMinutes: z.number().int().min(5).max(240).default(30),
    requirePhoto: z.boolean().default(false),
    requireFace: z.boolean().default(false),
    requireLiveness: z.boolean().default(false),
    requireScene: z.boolean().default(false),
  })
  .refine((v) => !v.requireGeo || v.geo !== null, { message: 'attendance.errors.geoMissing' });

export type AttendancePunchInput = z.infer<typeof AttendancePunchInputSchema>;
export type AttendancePolicySaveInput = z.infer<typeof AttendancePolicySaveInputSchema>;

export const AttendancePayRateSetInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
  dailyWage: SettlementMoneySchema,
  effectiveFrom: DateStringSchema,
});

export const AttendanceOvertimeDecideInputSchema = z.object({
  storeId: UuidSchema,
  overtimeId: UuidSchema,
  approve: z.boolean(),
  note: z.string().trim().max(300).optional(),
});

export const AttendanceWageSuggestionsInputSchema = z.object({
  storeId: UuidSchema,
  date: DateStringSchema,
});

/** A month's attendance as a spreadsheet (YYYY-MM, in the store's zone). */
export const AttendanceExportLinkInputSchema = z.object({
  storeId: UuidSchema,
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  locale: LocaleSchema,
});

export const AttendancePunchPhotosInputSchema = z.object({
  storeId: UuidSchema,
  punchId: UuidSchema,
});

/** Make a punch's face photo the member's reference face. */
export const AttendanceFaceRefSetInputSchema = z.object({
  storeId: UuidSchema,
  punchId: UuidSchema,
});

export const AttendanceFaceRefInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
});
