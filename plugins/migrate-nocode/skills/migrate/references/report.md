# Final report template

Deliver this in the chat (and save it as `docs/report.md`), then open `/review`.

```markdown
# Migration report: <client> (<platform> → Next.js)
Live: <url> · snapshot <date> (re-synced <date>) · build <commit>

## Result
| Page | Width | Height live / local | Pixels | Divergences | Sections props |
|---|---|---|---|---|---|
| / | 1920 | 6210 / 6210 | 0.02% | 0 | 0 |
| … | | | | | |
Summary: N routes × 4 widths, N passed, N with declared exceptions.

## Exceptions (each with reason and numbers)
## Deliberate deviations from live (polish layer, fixed live bugs)
## Pending, by owner
- Client: …
- Dev: …
- Content: …
## Waits for the CMS stage
collections, posts, real forms, media move to storage…
## Deploy checklist
- Database needed now? (visual stage: no)
- Env vars required / optional (e.g. REVIEW_PASSWORD)
- Asset weight in public/ (mirrored media can reach ~1 GB: plan object storage in the CMS stage)
- Domain, redirects, HSTS/security headers to confirm, forms backend (none → no mail service needed)
## Message for the client (ready to paste)
Short, plain language: what was migrated, what changed compared to the live site and where, what we need from them,
and that only the manageable content (CMS) is left.
## Recommended next step
```

Before writing it: re-run `run-all.mjs --sections`, `texts.mjs`, `head-check.mjs`, `intent-check.mjs`, then
`build-review.mjs --measure --open`. Ask before any push or deploy.
