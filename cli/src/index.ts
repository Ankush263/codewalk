#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { runFn } from './commands/fn.js';
import { runIndex } from './commands/index.js';
import { runInit } from './commands/init.js';
import { loadCodewalkEnv } from './commands/shared.js';

loadCodewalkEnv();

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

program
  .command('fn')
  .description('walkthrough of a function (<file>#<symbolName>) or a line range (<file>:<startLine>-<endLine>)')
  .argument('<target>', 'e.g. api/services/enrollService.ts#enrollPatient or api/app.ts:10-24')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of callees to include', parseDepth, 2)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json']).default('terminal'))
  .action(async (target: string, opts: { llm: boolean; depth: number; out: 'terminal' | 'json' }) => {
    process.exitCode = await runFn(process.cwd(), target, opts, io);
  });

await program.parseAsync();

function parseDepth(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}
