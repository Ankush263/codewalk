# Phase 6: `walk serve` (web UI) Design

**Spec:** `CLAUDE.md` §5 (`walk serve`), §7 (renderer: local web UI), §8.3 (verifier), §9 (staleness), §12 Phase 6, §11 (`web/`: React + Vite).

**Goal:** `walk serve` opens a local web UI for saved walkthroughs. It has:
- a list of saved walkthroughs with fresh/stale status;
- a reader with code on the left and the explanation on the right, plus the diagram;
- grounded, verified Q&A on any step, saved with the walkthrough;
- an optional "predict first, then reveal" mode.

Stale walkthroughs can be regenerated from the UI. Creating new ones stays in the CLI.

**Acceptance (CLAUDE.md §12):**
1. On the fixture, `walk serve` shows the saved `POST /api/patients/enroll` walkthrough step by step, with code beside each explanation and its sequence diagram.
2. A question on a step returns an answer whose references were verified against the index; the answer is saved and survives a reload.
3. Predict mode hides each explanation until the reader writes a prediction.

## Decisions (approved)

1. **Q&A is grounded and verified.** For each question, the server:
   - rebuilds the walkthrough's static context from the current index, with the same builder the CLI uses for that kind (fn, file section, endpoint, component, trace);
   - sends the facts, the step and the question, and asks for strict JSON `{ answer, references[] }`;
   - drops references outside the context's files or line bounds;
   - flags identifiers the facts don't contain as warnings.

   If the facts don't cover the question, the answer says so.
2. **UI scope is view plus regenerate-stale.** The UI lists, reads, asks, and regenerates stale walkthroughs. Regenerating reuses the CLI command for that kind, so fresh parts are reused and only stale code is re-sent.
3. **Predict mode is write, then compare.** It is toggled per session. Each step first shows only the code and a prediction box; "Reveal" (enabled once something is written) shows the explanation under the prediction. Predictions live only in the browser's `localStorage`. There is no LLM grading.
4. **Q&A is saved with the walkthrough.** Answers go in a `walkthrough_questions` table keyed by scope and step id, together with the step's hash at the time of the question. An answer is stale when its step is stale or was regenerated. Answers are exported into the Markdown mirror.

## 1. LLM

- `LlmProvider.generate` takes an optional `schema`. `AnthropicProvider` uses it for structured outputs, defaulting to the walkthrough schema. `generateStructured(provider, { system, prompt, schema })` holds the existing retry-on-invalid logic (≤ 2 retries); `generateWalkthrough` uses it.
- `answerSchema = { answer: string, references: Reference[] }`.
- The Q&A prompt is the scope's rendered facts (the same prompt the walkthrough was written from, minus its final "Write …" instruction), then the step (location, code lines, explanation), then the question. The rules match the walkthrough rules: cite only given locations; backtick identifiers; say when the facts don't cover it.
- `checkAnswer(answer, facts) → { references, warnings }`, using the same file and line-bound checks and vocabulary as §8.3.

## 2. Storage

Migration `walkthrough_questions(id, scope_kind, scope_ref, step_id, question, answer JSONB {answer, references, warnings}, step_hash, model, created_at)`, indexed on `(scope_kind, scope_ref)`.

The store gets `saveQuestion` and `listQuestions(kind, ref)`. `persistWalkthrough` passes the questions to `renderMarkdown`, which prints them under their step. File walkthroughs use the flattened `<symbol>/<step>` id everywhere.

## 3. Core view model (`core/src/api.ts`, `core/src/walkthrough/{status,detail,question}.ts`)

- `walkthroughStatus(store, repoRoot, saved)` and `walkthroughStatuses(store, repoRoot)` contain the chain/structure/trace-hash dispatch that `walk list` has today. `walk list` uses them.
- `describeStaleness(kind, status)` moves from the CLI formatter to core.
- `walkthroughNotes(saved)` holds the overview/endpoint/component/trace notes dispatch, shared by the CLI output and the UI.
- `walkthroughDetail(store, repoRoot, kind, ref) → WalkthroughDetail | null` contains:
  - the saved walkthrough flattened;
  - notes and diagram;
  - fresh/stale summary;
  - per-step state (fresh, current location) by flattened id;
  - the current lines of every file a step or reference cites;
  - the saved questions, each marked stale or not.
- `askQuestion(provider, store, repoRoot, saved, stepId, question, { model, maxContextTokens }) → QuestionRecord` builds the context, generates and checks the answer, saves it, and refreshes the Markdown mirror.

## 4. Server (`cli/src/serve/`)

A plain `node:http` server bound to `127.0.0.1` (`--port`, default 4321). Routes:

| route | does |
|---|---|
| `GET /api/walkthroughs` | index (incremental) → list items |
| `GET /api/walkthrough?kind=&ref=` | index → `WalkthroughDetail` (404 if none) |
| `POST /api/questions` `{kind, ref, stepId, question}` | index → `askQuestion` → `QuestionView` |
| `POST /api/regenerate` `{kind, ref}` | run the kind's CLI command (`refresh: false`, saved depth) → new detail |
| `GET /*` | static files from `web/dist` (`index.html` at `/`); 503 with build instructions when it isn't built |

Security for a local server that can spend LLM credits:
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- POSTs require `X-Codewalk: 1` and a JSON body (a cross-site page cannot send that without a CORS preflight, which the server never answers), with a 64 KB limit.
- Static paths are resolved inside the web root only.
- Known user errors (target, LLM, verification, pin needed) map to 4xx/502 with their message.

`walk serve [--port <n>]` loads the repo, migrates, indexes, starts the server, prints the URL and runs until Ctrl-C.

## 5. Web app (`web/`, React + Vite)

- **Navigation:** hash routes `#/` (list) and `#/w/<kind>/<ref>` (reader).
- **Reader:**
  - header with title, ref, summary, collapsible notes and diagram (Mermaid, bundled and lazy-loaded, `securityLevel: 'strict'`);
  - stale banner with **Regenerate**;
  - predict-mode toggle;
  - step pager (buttons, Prev/Next, ←/→ keys outside text fields).
- **Two columns:**
  - the code panel shows the step's lines highlighted, with 6 dimmed lines around them; clicking a reference shows that file and line;
  - the explanation panel shows the explanation (backticked spans as code), example input / state after, references, docs links, concepts, risks, a stale badge, and the Q&A thread with an ask box.
- **Testing seams:** the API, prediction storage and diagram renderer are injected, so components are tested in jsdom with Testing Library, without a server or Mermaid.

## 6. Testing

- **LLM (pure):** `generateStructured` retries with any schema; `checkAnswer` drops out-of-context references and warns on unknown identifiers.
- **Store/Markdown (real Postgres):** migration, save/list questions, and Markdown with Q&A.
- **Core (fixture plus temp copy):** `askQuestion` on a seeded endpoint walkthrough (recorded answer); `locateStep` for file walkthroughs; `walkthroughDetail` fresh and then stale after editing `insertConsent`; `walkthroughStatuses`.
- **Server (real HTTP on port 0):**
  - list, detail, ask and regenerate;
  - rejects a POST without the header and a foreign Host;
  - static serving, path traversal and the unbuilt web root.
- **Web (jsdom):** list rendering and links; reader navigation (buttons and keys); code highlighting; reference focus; stale banner with regenerate; diagram via a stub; predict hide/reveal/persist; ask, answer and error.
- **Manual:** `pnpm --filter @codewalk/web build`, then `walk serve` on the fixture, opened in a browser.

## Out of scope

Creating new walkthroughs or choosing pins from the UI, LLM-graded predictions, auth/multi-user, remote hosting, live reload on file changes, and syntax highlighting beyond line highlighting.
