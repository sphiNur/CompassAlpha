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
  /**
   * Taken on the spot (base64 JPEGs): the face, always (face-only
   * clocking, 2026-11-06), and the place where the store asks for it.
   */
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
  /** Clocking on a colleague's phone: the server finds who it is by the face. */
  identify: z.boolean().optional(),
});

export const AttendanceLivenessChallengeInputSchema = z.object({
  storeId: UuidSchema,
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

/**
 * A guided face enrollment (2026-11-06): six photos, taken by the phone
 * when the head is where the prompt asks.
 */
export const AttendanceFaceEnrollInputSchema = z.object({
  storeId: UuidSchema,
  photos: z.object({
    front: AttendancePhotoSchema,
    left: AttendancePhotoSchema,
    right: AttendancePhotoSchema,
    up: AttendancePhotoSchema,
    down: AttendancePhotoSchema,
    front2: AttendancePhotoSchema,
  }),
});

/** A manager approves an enrollment, or sends it back with a reason. */
export const AttendanceFaceEnrollDecideInputSchema = z
  .object({
    storeId: UuidSchema,
    enrollmentId: UuidSchema,
    approve: z.boolean(),
    note: z.string().trim().max(300).optional(),
  })
  .refine((v) => v.approve || (v.note ?? '').length > 0, {
    message: 'attendance.errors.enrollNoteRequired',
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
    graceMinutes: z.number().int().min(0).max(120),
    overtimeAfterMinutes: z.number().int().min(5).max(240).default(30),
    /** Face, liveness and the photo are always on (2026-11-06); the place photo is a choice. */
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

/** One person's face enrollment, for a manager. */
export const AttendanceFaceMemberInputSchema = z.object({
  storeId: UuidSchema,
  memberId: UuidSchema,
});
