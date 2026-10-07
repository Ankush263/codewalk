#!/usr/bin/env node
import { Command } from 'commander';
import { runIndex } from './commands/index.js';
import { runInit } from './commands/init.js';

const io = { log: console.log, error: console.error };

const program = new Command('walk')
  .description('Step-by-step, verified walkthroughs of TypeScript code')
  .version('0.0.1');

program
  .command('init')
  .description('create .walkthrough/config.json, connect to Postgres, run migrations and build the index')
  .action(async () => {
    process.exitCode = await runInit(process.cwd(), io);
  });

program
  .command('index')
  .description('(re)build the symbol graph; only changed files are re-indexed')
  .action(async () => {
    process.exitCode = await runIndex(process.cwd(), io);
  });

await program.parseAsync();
