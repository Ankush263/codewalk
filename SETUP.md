# Codewalk: Setup Guide

A step-by-step guide to setting up the **Walkthrough** code comprehension tool described in `CLAUDE.md`.
Run each command from the project root (`~/dev/projects/codewalk`) unless a step says otherwise.

> **How to read this guide**
>
> - Lines starting with `#` inside code blocks are comments that explain the command. You don't need to type them.
> - ✅ **Check** lines tell you how to confirm a step worked before moving on.
> - Steps 0–3 are one-time setup. Steps 4–9 are the build phases from `CLAUDE.md` §12.

---

## Contents

0. [Prerequisites](#step-0-prerequisites)
1. [Workspace skeleton](#step-1-workspace-skeleton)
2. [Database (Postgres + pgvector)](#step-2-database-postgres--pgvector)
3. [Fixture repo](#step-3-fixture-repo)
4. [Phase 1: `walk fn`](#step-4-phase-1--walk-fn)
5. [Phases 2–6](#steps-59-phases-26)
6. [Daily workflow cheat sheet](#daily-workflow-cheat-sheet)
7. [Troubleshooting](#troubleshooting)

---

## Step 0: Prerequisites

### 0.1 Node.js 24+

Right now `node -v` prints nvm's help text, which means Node isn't activated. Fix it:

```bash
# Install Node 24 (LTS) with nvm
nvm install 24

# Make Node 24 the default in every new terminal
nvm alias default 24

# Open a NEW terminal, then confirm the version
node -v        # should print v24.x.x (or newer)
```

✅ **Check:** `node -v` prints a version number in a fresh terminal.

### 0.2 Other tools (already installed on this machine)

```bash
pnpm -v              # package manager for the monorepo (have: 10.x)
docker -v            # runs Postgres locally (have: 29.x)
docker compose version
git --version
```

If pnpm is ever missing, run `corepack enable && corepack prepare pnpm@latest --activate`.

### 0.3 Free up port 5432

Homebrew Postgres is installed. If its **server** is running, it takes port 5432 and the Docker database can't start.

```bash
# Is anything already listening on 5432?
lsof -i :5432

# If Homebrew Postgres is running, stop it (you can start it again later)
brew services stop postgresql@18 2>/dev/null || brew services stop postgresql
```

> If you need Homebrew Postgres running, change the Docker port mapping to `"5433:5432"` in Step 2 and use `localhost:5433` in every URL.

### 0.4 Anthropic API key

```bash
# Get a key from https://console.anthropic.com → API Keys.
# It goes in the .env file created in Step 1. Never commit it.
```

### 0.5 Initialise git

```bash
# Version control lets you review each phase as a diff and roll back if needed
git init
```

---

## Step 1: Workspace skeleton

### 1.1 Folder structure

Three packages, all at the top level. No nested `packages/` or `apps/` folders to dig through.

```bash
# Create every folder in one go
mkdir -p core/src/{store/migrations,indexer,context,llm,verifier} \
         cli/src/{commands,ui} \
         web/src \
         fixture/{api,web}
```

The resulting layout:

```
codewalk/
├── core/                 # the engine: everything except the UI
│   └── src/
│       ├── config.ts     # loads .walkthrough/config.json
│       ├── store/        # the ONLY place that talks to Postgres (+ migrations/)
│       ├── indexer/      # ts-morph: reads code, fills the database
│       ├── context/      # picks the code + facts to send to the LLM
│       ├── llm/          # Anthropic client, prompts, zod schemas
│       └── verifier/     # rejects fake file:line references
├── cli/                  # the `walk` command
│   └── src/
│       ├── commands/     # one file per command (init.ts, fn.ts, ...)
│       └── ui/           # Ink terminal stepper
├── web/                  # local web UI (Phase 6 only)
├── fixture/              # small fake app the tests run against
│   ├── api/              # Express backend
│   └── web/              # React frontend
├── docker-compose.yml
└── CLAUDE.md             # the spec
```

**Rule of thumb:** looking for logic → `core/`. Looking for a command or what's printed → `cli/`.

### 1.2 Root config files

```bash
# Pin the Node version so `nvm use` picks it up automatically
echo "24" > .nvmrc

# Tell pnpm which folders are workspace packages
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "core"
  - "cli"
  - "web"
EOF
# fixture/ is deliberately NOT a workspace package: it's only parsed, never installed or run.

# Keep secrets, builds and dependencies out of git
cat > .gitignore <<'EOF'
node_modules/
dist/
.env
.walkthrough/
coverage/
*.log
EOF

# Template for environment variables. Copy it to .env and fill in real values.
cat > .env.example <<'EOF'
# Postgres started by docker-compose.yml
DATABASE_URL=postgres://codewalk:codewalk@localhost:5432/codewalk
# Your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-...
EOF
cp .env.example .env    # now edit .env and paste your real API key
```

Root `package.json`, with scripts that run across all packages:

```bash
cat > package.json <<'EOF'
{
  "name": "codewalk",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "build": "pnpm -r build",
    "dev": "pnpm -r --parallel dev",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "db:up": "docker compose up -d",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d",
    "db:psql": "docker compose exec postgres psql -U codewalk -d codewalk"
  }
}
EOF
```

Shared TypeScript settings, inherited by every package:

```bash
cat > tsconfig.base.json <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "jsx": "react-jsx",
    "resolveJsonModule": true
  }
}
EOF
```

### 1.3 Per-package `package.json`

```bash
# Create a minimal package.json + tsconfig for each package.
# Packages are named @codewalk/<name> so they can import each other.
for p in core cli web; do
cat > $p/package.json <<EOF
{
  "name": "@codewalk/$p",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsup src/index.ts --format esm --clean && tsc --emitDeclarationOnly",
    "dev": "tsup src/index.ts --format esm --watch",
    "typecheck": "tsc --noEmit"
  }
}
EOF
cat > $p/tsconfig.json <<'EOF'
{ "extends": "../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
EOF
echo "export {};" > $p/src/index.ts   # placeholder entry so builds succeed
done
```

> **Why the build is two steps:** this project uses TypeScript 7 (the native rewrite). tsup's `--dts` option relies on the old TypeScript JavaScript API, which TypeScript 7 removed, so it crashes. Instead, tsup builds the `.js` and TypeScript 7's own `tsc` writes the `.d.ts` files.
> `"rootDir": "src"` is required: without it TypeScript 7 fails with `TS5011` and would put types in `dist/src/` instead of `dist/`.

The CLI also needs a `bin` entry so `walk` becomes a command. Add this to `cli/package.json`:

```json
"bin": { "walk": "dist/index.js" }
```

### 1.4 Install dependencies

```bash
# -D = dev dependency, -w = install at the workspace root (shared by all packages)
pnpm add -Dw typescript@^7 tsup vitest @types/node tsx dotenv
# (ts-morph bundles its own TypeScript, so the indexer isn't affected by the TS 7 install)

# core: TS code analysis, Postgres driver, migrations, vector support, validation, Anthropic SDK
pnpm --filter @codewalk/core add ts-morph pg node-pg-migrate pgvector zod @anthropic-ai/sdk
pnpm --filter @codewalk/core add -D @types/pg

# cli: argument parsing + React-based terminal UI
pnpm --filter @codewalk/cli add commander ink react
pnpm --filter @codewalk/cli add -D @types/react

# Let the CLI use core through the workspace (not npm)
pnpm --filter @codewalk/cli add "@codewalk/core@workspace:*"

# web: only needed in Phase 6, skip for now
# pnpm --filter @codewalk/web add react react-dom && pnpm --filter @codewalk/web add -D vite @vitejs/plugin-react
```

✅ **Check:**

```bash
pnpm install          # should finish without errors
pnpm build            # every package builds (they're empty for now)
pnpm test             # vitest runs; "no test files found" is fine at this stage
```

```bash
git add -A && git commit -m "chore: workspace skeleton"
```

---

## Step 2: Database (Postgres + pgvector)

### 2.1 `docker-compose.yml`

```bash
cat > docker-compose.yml <<'EOF'
services:
  postgres:
    # Official Postgres 16 image with the pgvector extension pre-installed
    image: pgvector/pgvector:pg16
    container_name: codewalk-postgres
    environment:
      POSTGRES_USER: codewalk
      POSTGRES_PASSWORD: codewalk
      POSTGRES_DB: codewalk
    ports:
      - "5432:5432"          # change to "5433:5432" if 5432 is taken
    volumes:
      - codewalk_pgdata:/var/lib/postgresql/data   # data survives restarts
    healthcheck:
      # Docker marks the container "healthy" once Postgres accepts connections
      test: ["CMD-SHELL", "pg_isready -U codewalk -d codewalk"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  codewalk_pgdata:
EOF
```

### 2.2 Start it and verify

```bash
# Start Postgres in the background
docker compose up -d

# Wait until STATUS shows "(healthy)"
docker compose ps

# Enable pgvector and print its version.
# Uses the psql inside the container, so it works without a local client.
docker compose exec postgres psql -U codewalk -d codewalk \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

✅ **Check:** the last command prints a version such as `0.8.0`.

### 2.3 Migrations

Migrations are versioned files that create the §8.1 tables. Each indexed repo gets its own Postgres schema (`cw_<repo_slug>`).

```bash
# Create the first migration file (Claude Code fills in the tables during Phase 1)
cd core
npx node-pg-migrate create initial-schema --migrations-dir src/store/migrations --migration-file-language ts
cd ..
```

Run migrations manually for a test schema:

```bash
# Loads DATABASE_URL from .env, then creates schema cw_demo and runs every migration into it
export $(grep -v '^#' .env | xargs)
npx node-pg-migrate up \
  --migrations-dir core/src/store/migrations \
  --schema cw_demo --create-schema \
  --tsx
```

✅ **Check:** list the tables that were created:

```bash
docker compose exec postgres psql -U codewalk -d codewalk -c "\dt cw_demo.*"
# Expect: files, symbols, calls, imports, routes, middleware, side_effects,
#         components, api_calls, cross_edges, walkthroughs (+ pgmigrations)
```

> Normally `walk init` runs the migrations for you. These manual commands are for debugging.

---

## Step 3: Fixture repo

`fixture/` is a small fake app that every test runs against. It needs:

| Case                                                       | Example file                                     |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Nested Express routers + `app.use` mounts                  | `api/app.ts`, `api/routes/{index,patients}.ts`   |
| Middleware chain (auth, rate limit, validate)              | `api/middleware/*.ts`                            |
| Service layer hitting Postgres + Redis                     | `api/services/enrollService.ts`                  |
| React component + custom hook + API mutation               | `web/components/EnrollForm.tsx`, `web/hooks/useEnrollMutation.ts` |
| Deliberately dynamic calls (should be marked "unresolved") | `handlers[name]()`, an event emitter             |

The fixture is only parsed, never executed, so it doesn't need its dependencies installed. It does need a `tsconfig.json` for ts-morph.

> Ask Claude Code: _"Create the fixture monorepo described in CLAUDE.md §14."_

```bash
git add -A && git commit -m "test: add fixture monorepo"
```

---

## Step 4: Phase 1, `walk fn`

What gets built, in order (CLAUDE.md §12 Phase 1):

| #   | Piece                                                                             | Where                      |
| --- | --------------------------------------------------------------------------------- | -------------------------- |
| 1   | Config loader (`.walkthrough/config.json`, validated with zod)                    | `core/src/config.ts`       |
| 2   | Store module + migrations (all SQL lives here)                                    | `core/src/store/`          |
| 3   | `walk init` (connect, migrate, index; prints a helpful message if the DB is down) | `cli/src/commands/init.ts` |
| 4   | ts-morph indexer (files, symbols, calls, imports; incremental)                    | `core/src/indexer/`        |
| 5   | Context builder for one function                                                  | `core/src/context/`        |
| 6   | LLM client + §8.2 zod schema + retry (max 2)                                      | `core/src/llm/`            |
| 7   | Verifier (reject fake `file:line` references)                                     | `core/src/verifier/`       |
| 8   | Ink stepper (prev/next) + `--no-llm` mode                                         | `cli/src/ui/`              |

> Ask Claude Code: _"Start Phase 1."_ It will list the files it plans to touch before writing any code.

### Try it on the fixture

```bash
# Build everything and link the `walk` command globally
pnpm build
pnpm --dir cli link --global          # run `pnpm setup` once first if PNPM_HOME is not set

# Go into the fixture repo and set it up
cd fixture
walk init                                   # creates .walkthrough/, migrates, indexes

# Static facts only (no LLM call, no API cost)
walk fn api/services/enrollService.ts#enrollPatient --no-llm

# Full walkthrough using Claude
walk fn api/services/enrollService.ts#enrollPatient

# Walkthrough of a line range instead of a named function
walk fn api/services/enrollService.ts:10-40
cd ..
```

Without linking globally, you can run the CLI straight from source:

```bash
npx tsx cli/src/index.ts fn <file>#<name> --no-llm
```

✅ **Accept when:** you see verified steps with at least one correct worked example, and `--no-llm` prints the static facts.

```bash
pnpm test && git add -A && git commit -m "feat: phase 1 — walk fn"
```

---

## Steps 5–9: Phases 2–6

Each phase follows the same loop:

```
Ask "Start Phase N"  →  review the plan  →  Claude builds it  →  run the accept check  →  commit
```

| Phase | Command(s) added         | Try it (run inside `fixture/`)                                      | ✅ Accept when                                                        |
| ----- | ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **2** | `walk file`, `walk list` | `walk file api/services/enrollService.ts --out md` then `walk list` | Editing one function marks only the affected steps stale              |
| **3** | `walk endpoint`          | `walk endpoint "POST /api/patients/enroll"`                             | Nested-router path, middleware order and side effects are all correct |
| **4** | `walk component`         | `walk component web/components/EnrollForm.tsx#EnrollForm`                      | Custom hook expanded, API call detected                               |
| **5** | `walk trace`             | `walk trace "POST /api/patients/enroll"`                                | Click → API → DB trace renders end to end                             |
| **6** | `walk serve`             | `walk serve` then open the printed URL                              | Code on the left, explanation on the right, diagram, Q&A              |

Testing staleness in Phase 2:

```bash
walk fn api/services/enrollService.ts#enrollPatient   # generate + cache
walk list                                                      # shows "fresh"
# ...edit one line inside enrollPatient, then...
walk index                                                     # re-index changed files only
walk list                                                      # now shows "stale"
```

---

## Daily workflow cheat sheet

```bash
# Start of day
nvm use                 # switch to the Node version in .nvmrc
pnpm db:up              # start Postgres

# While coding
pnpm dev                # rebuild packages automatically on save
pnpm test:watch         # re-run tests on save
pnpm typecheck          # catch type errors across all packages

# Inspect the database
pnpm db:psql            # opens psql inside the container
#   \dn                 → list schemas (one cw_* per indexed repo)
#   \dt cw_demo.*       → list tables in a schema
#   SET search_path TO cw_demo;  SELECT name, kind FROM symbols LIMIT 20;

# Start fresh (DELETES all indexed data)
pnpm db:reset

# End of day
pnpm db:down            # stop Postgres (data is kept)
```

---

## Troubleshooting

| Symptom                                            | Likely cause                                 | Fix                                                                            |
| -------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------ |
| `node -v` prints nvm help                          | Node isn't activated                         | `nvm install 24 && nvm alias default 24`, then open a new terminal             |
| `port is already allocated` on `docker compose up` | Homebrew Postgres is using 5432              | `brew services stop postgresql@18`, or map the container to `5433:5432`        |
| `ECONNREFUSED 127.0.0.1:5432`                      | Container isn't running or isn't healthy yet | `docker compose up -d && docker compose ps`                                    |
| `type "vector" does not exist`                     | Extension not enabled in this database       | `pnpm db:psql` then `CREATE EXTENSION vector;`                                 |
| `Cannot find module '@codewalk/core'`              | Workspace package not built                  | `pnpm build`                                                                   |
| `walk: command not found`                          | CLI not linked                               | `pnpm --dir cli link --global`, or use `npx tsx cli/src/index.ts` |
| `401` / `authentication_error` from the LLM        | Missing or wrong API key                     | Check `ANTHROPIC_API_KEY` in `.env`                                            |
| ESM errors such as `require is not defined`        | Ink and some dependencies are ESM-only       | Keep `"type": "module"` in every `package.json`                                |
| `Cannot read properties of undefined (reading 'useCaseSensitiveFileNames')` on build | tsup `--dts` doesn't work with TypeScript 7 | Remove `--dts`; build types with `tsc --emitDeclarationOnly` (see §1.3) |
| `error TS5011: ... rootDir must be explicitly set` | TypeScript 7 no longer guesses the source root | Add `"rootDir": "src"` to the package's `tsconfig.json` |
| Docker daemon not running                          | Docker Desktop is closed                     | `open -a Docker`, wait about 20 seconds, then retry                            |
