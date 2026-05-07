import type { Command } from 'commander';
import kleur from 'kleur';

export function registerTestCommands(parent: Command): void {
  parent
    .command('purge')
    .description('Purge test data within a date range. Mirrors system.purgeTestData but offline.')
    .requiredOption('--org <slug>')
    .requiredOption('--from <date>', 'YYYY-MM-DD')
    .requiredOption('--to <date>', 'YYYY-MM-DD')
    .option('--dry-run', 'Preview only', true)
    .action(async (opts) => {
      // Implementation note: this should reuse the same routine as the API
      // (`apps/api/src/services/purgeTestData.ts`) once that lands. For
      // Milestone 0 we only ship the CLI surface; the routine itself is a
      // followup so the same code path is used by both UI button and CLI.
      console.log(kleur.yellow('[stub] purge'), opts);
      console.log('  Not implemented in M0. Use /debug → Purge button instead.');
    });
}
