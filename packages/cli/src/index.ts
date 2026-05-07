#!/usr/bin/env bun
/**
 * `compass` — operations CLI.
 *
 * Goals:
 *   - Wrap admin DB tasks (org, user, role) so we never SSH+psql.
 *   - Same code path the API uses (no ad-hoc inline SQL).
 *
 * Subcommands are registered as separate modules so the surface stays small.
 */
import { Command } from 'commander';
import kleur from 'kleur';
import { registerOrgCommands } from './commands/org';
import { registerUserCommands } from './commands/user';
import { registerTestCommands } from './commands/test';
import { registerProjectCommands } from './commands/project';

const program = new Command();
program
  .name('compass')
  .description('Compass operations CLI')
  .version('0.1.0')
  .showHelpAfterError();

registerOrgCommands(program.command('org').description('Manage organizations'));
registerUserCommands(program.command('user').description('Manage users and roles'));
registerTestCommands(program.command('test').description('Test-data utilities'));
registerProjectCommands(program.command('project').description('Projection management'));

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red('[compass] Failed:'), err);
  process.exit(1);
});
