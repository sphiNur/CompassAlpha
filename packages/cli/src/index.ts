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
// First, so that the repository's .env is loaded before any other module.
import './env';
import { Command } from 'commander';
import kleur from 'kleur';
import pkg from '../package.json';
import { registerOrgCommands } from './commands/org';
import { registerUserCommands } from './commands/user';
import { registerProjectCommands } from './commands/project';
import { registerPlatformCommands } from './commands/platform';
import { Refusal } from './refusal';

const program = new Command();
program
  .name('compass')
  .description('Compass operations CLI')
  .version(pkg.version)
  .showHelpAfterError();

registerOrgCommands(program.command('org').description('Manage organizations'));
registerUserCommands(program.command('user').description('Manage users and roles'));
registerProjectCommands(program.command('project').description('Projection management'));
registerPlatformCommands(
  program.command('platform').description('Manage cross-tenant platform administrators'),
);

program.parseAsync(process.argv).catch((err: unknown) => {
  // A refusal is the command's own answer; anything else is a failure.
  if (err instanceof Refusal) console.error(kleur.red(err.message));
  else console.error(kleur.red('[compass] Failed:'), err);
  process.exit(1);
});
