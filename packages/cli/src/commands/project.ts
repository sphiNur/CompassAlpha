import type { Command } from 'commander';
import kleur from 'kleur';

export function registerProjectCommands(parent: Command): void {
  parent
    .command('rebuild <stream>')
    .description('Not implemented — use `pnpm --filter @compass/api reproject` (see RUNBOOK).')
    .action(async (stream: string) => {
      // 2026-10-21 audit CA-14: this used to print "[stub]" and exit 0, which
      // the RUNBOOK sent operators to during an incident. The real rebuild
      // is apps/api/scripts/reproject.ts; point there and fail loudly.
      console.error(kleur.red('compass project rebuild is not implemented.'), { stream });
      console.error(
        `  Run instead: pnpm --filter @compass/api reproject --type=${stream === 'run' ? 'run' : 'order'}`,
      );
      process.exitCode = 1;
    });
}
