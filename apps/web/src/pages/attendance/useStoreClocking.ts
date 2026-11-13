/**
 * A3 (2026-11-13): who clocks in at one store, for the screens outside
 * Attendance that switch it (the invite form, a member's ⋯ sheet).
 *
 * Offered only to someone who manages attendance there, and only once
 * the store uses it: someone there already clocks in. There is no
 * "attendance on" switch of its own; a store nobody clocks at is set up
 * from Admin › Attendance first.
 */
import { trpc } from '../../lib/trpc';
import { orgToday } from '../../lib/calendarDate';
import { useErrToast } from '../../hooks/useErrToast';
import { useAuthStore } from '../../stores/authStore';

export function useStoreClocking(storeId: string | null, enabled = true) {
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const manages = useAuthStore((s) => {
    const session = s.session;
    if (!session || !storeId) return false;
    return (session.storePermissions?.[storeId] ?? session.permissions).includes(
      'attendance.manage',
    );
  });
  const today = orgToday(orgTimeZone);
  const sheet = trpc.attendance.sheet.useQuery(
    { storeId: storeId ?? '', from: today, to: today },
    { enabled: enabled && manages && !!storeId },
  );
  const memberSet = trpc.attendance.memberSet.useMutation({
    onSuccess: () => void utils.attendance.sheet.invalidate(),
    onError: errToast('attendance.errors.saveFailed'),
  });
  const members = sheet.data?.members ?? [];
  return {
    /** The switch may be shown: they manage it and the store uses it. */
    offered: manages && members.some((m) => m.enabled),
    clocks: (memberId: string) => members.some((m) => m.memberId === memberId && m.enabled),
    set: (memberId: string, on: boolean) =>
      storeId ? memberSet.mutateAsync({ storeId, memberId, enabled: on }) : Promise.resolve(),
    pending: memberSet.isPending,
  };
}
