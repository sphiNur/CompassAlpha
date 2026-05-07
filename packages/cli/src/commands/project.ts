import type { Command } from 'commander';
import kleur from 'kleur';

export function registerProjectCommands(parent: Command): void {
  parent
    .command('rebuild <stream>')
    .description('Drop a read_model and replay events. Allowed values: order, run.')
    .action(async (stream: string) => {
      // Same note as test.purge: routine lives server-side, CLI delegates.
      console.log(kleur.yellow('[stub] rebuild'), { stream });
      console.log('  Not implemented in M0. Implement in apps/worker.');
    });
}
