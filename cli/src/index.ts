#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { runFile, type FileOptions } from './commands/file.js';
import { runComponent, type ComponentOptions } from './commands/component.js';
import { runEndpoint, type EndpointOptions } from './commands/endpoint.js';
import { runFn, type FnOptions } from './commands/fn.js';
import { runList } from './commands/list.js';
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
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (target: string, opts: FnOptions) => {
    process.exitCode = await runFn(process.cwd(), target, opts, io);
  });

program
  .command('file')
  .description('walkthrough of a whole file: every function, helpers first')
  .argument('<file>', 'e.g. api/services/enrollService.ts')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of callees to include per function', parseDepth, 2)
  .option('--refresh', 'ignore saved walkthroughs and regenerate every function', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (file: string, opts: FileOptions) => {
    process.exitCode = await runFile(process.cwd(), file, opts, io);
  });

program
  .command('endpoint')
  .description('walkthrough of a backend endpoint: mounts, middleware chain, handler, side effects')
  .argument('<route>', 'e.g. "POST /api/patients/enroll" (a concrete path like "GET /api/patients/42" also works)')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of calls below the handler and middleware to include', parseDepth, 3)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (route: string, opts: EndpointOptions) => {
    process.exitCode = await runEndpoint(process.cwd(), route, opts, io);
  });

program
  .command('component')
  .description('walkthrough of a React component: props, state, render tree, hooks, handlers, API calls')
  .argument('<target>', 'e.g. web/components/EnrollForm.tsx#EnrollForm (the name is optional when the file has one component)')
  .option('--no-llm', 'print only the static facts')
  .option('--depth <n>', 'how many levels of custom hooks and calls to expand', parseDepth, 2)
  .option('--refresh', 'ignore the saved walkthrough and regenerate', false)
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json', 'md']).default('terminal'))
  .action(async (target: string, opts: ComponentOptions) => {
    process.exitCode = await runComponent(process.cwd(), target, opts, io);
  });

program
  .command('list')
  .description('list saved walkthroughs and whether the code they explain has changed')
  .addOption(new Option('--out <format>', 'output format').choices(['terminal', 'json']).default('terminal'))
  .action(async (opts: { out: 'terminal' | 'json' }) => {
    process.exitCode = await runList(process.cwd(), opts, io);
  });

await program.parseAsync();

function parseDepth(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}
