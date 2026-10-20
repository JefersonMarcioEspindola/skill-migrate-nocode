# Parallel page agents

Once foundations and shared components are measured clean, pages go in parallel. This is where most of the speed
comes from, and where usage limits and file collisions hurt most.

## Rules that came from real failures
- **At most 3 agents at once.** A usage limit once killed four page agents simultaneously, twice, and measured work
  was lost because it wasn't committed. Before each batch: commit + board updated.
- **One owner per file.** Each agent edits only its page files (e.g. `app/<route>/**`, `lib/data/<collection>.json`,
  a new `styles/<page>.css`). It never edits shared components, layout, global CSS, package.json or the tools.
  Needs a shared change? It writes the request in its report; the orchestrator applies it.
- **Own output folder**: `MIGRATE_OUT=tools/out/<agent>` so parallel runs don't overwrite each other's summaries.
- **Relative paths** for `--out` (an absolute path once wrote into a nested `private/...` folder).
- **Nobody stops or restarts the server.** The orchestrator rebuilds (`next build && next start`) before each
  measurement round; agents measure against it.
- Agents don't commit; the orchestrator integrates, rebuilds, re-measures and commits per item.
- Progress file per agent: `docs/agents/<item>.md`, updated after each page/width done, so a resumed agent (or a
  new one) knows where it was. When a limit stops an agent, resume the SAME agent with what changed meanwhile.
- Use worktrees only if the user accepted branches; otherwise all agents share the checkout under the rules above.

## The brief each page agent gets
1. Its routes (all locales) and the snapshot files (`snapshots/<date>/html/<slug>.html`, `facts/<slug>.json`).
2. The tools and how to run them (copy the commands from SKILL.md phases 2–5).
3. A summary of foundations: what is already global (fonts, base CSS, header, footer, runtime) and must not be redone.
4. The definition of done (criteria.md) for 1920, 1440, 768 and 390, and that "done" means `sections` too, not only
   `measure`, on EVERY route of a template collection (an agent once measured 7 of 36 project pages and called it done).
5. Report format: per route × width, height live/local, pixel %, divergences, sections props diff, states and motion
   checked, exceptions with reasons, requests for shared changes.

## Collections (posts, case studies, team, jobs)
One template + `lib/data/<collection>.json` extracted from the snapshot by a script that aborts on unexpected
classes or block types (that's how you discover the 6 gallery variants instead of guessing). Then `verify-dom.mjs` on
every route of the collection plus a full `run-all` on all of them.
