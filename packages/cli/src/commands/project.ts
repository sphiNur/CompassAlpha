import { Argument, type Command } from 'commander';
import { Refusal } from '../refusal';

/** The `--type` values of apps/api/scripts/reproject.ts. */
const STREAMS = ['run', 'order', 'all'] as const;

export function registerProjectCommands(parent: Command): void {
  parent
    .command('rebuild')
    .addArgument(new Argument('<stream>', 'the stream type to replay').choices(STREAMS))
    .description('Not implemented — use `pnpm --filter @compass/api reproject` (see RUNBOOK).')
    .action(async (stream: (typeof STREAMS)[number]) => {
      // 2026-10-21 audit CA-14: this used to print "[stub]" and exit 0, which
      // the RUNBOOK sent operators to during an incident. The real rebuild
      // is apps/api/scripts/reproject.ts; point there and fail loudly.
      // Review OPS-41 (2026-11): with the stream asked for. Every stream but
      // run used to be sent to --type=order.
      throw new Refusal(
        'compass project rebuild is not implemented.\n' +
          `  Run instead: pnpm --filter @compass/api reproject --type=${stream}`,
      );
    });
}
