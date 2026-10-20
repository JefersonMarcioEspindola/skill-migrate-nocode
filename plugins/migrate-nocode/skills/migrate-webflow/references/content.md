# Webflow CMS content → normalized format

Two paths, same output (`content/*.json`, see `migrate-content/references/content-format.md`):

| | Data API v2 (`webflow-cms-export.mjs`) | Designer CSV (`webflow-csv-import.mjs`) |
|---|---|---|
| Needs | Site API token (site admin creates it) | Designer access to the CMS panel |
| Field types | exact schema (`GET /collections/{id}`) | inferred from values (`inferred: true`), override with `--schema` |
| Ids / references | real item ids, references by id | Item ID column; references exported as **slugs**, resolved across the CSVs you pass together |
| Drafts / archived | staged + live items, `isDraft`, `isArchived` | `Draft` / `Archived` columns |
| Published vs edited | live version by default, `--prefer staged` for unpublished edits | only the staged (latest) version |
| Locales | every locale (`cmsLocaleId`), variants share the item id | only the locale active in the Designer; one export per locale |
| Image alt text | yes (`{fileId, url, alt}`) | **no** |
| Option values | option id → mapped to the option name | option name |

Prefer the API whenever the client can create a token.

## Path A — Data API v2

### Create the token (client side, 2 minutes)

1. Webflow Dashboard → the site's gear icon (**Site settings**) → **Apps & integrations**.
2. Scroll to **API access** → **Generate API token**.
3. Name it ("migration, read-only"), scopes **Sites: read** and **CMS: read**. Nothing else is needed.
4. Copy the token once and send it through a secret channel. Only site administrators can create tokens;
   up to 5 per site; a token expires after 365 days without use. Revoke it in the same screen after the migration.

Workspace tokens (Enterprise) have no CMS access: use a site token.

### Run

```bash
export WEBFLOW_API_TOKEN=…            # never commit it, never paste it into files
node webflow-cms-export.mjs --site my-site --out content --routes "blog=/blog/:slug" --rpm 60
node webflow-cms-export.mjs --from-raw content/_raw/webflow   # re-normalize offline (no network)
node ../../migrate-content/scripts/content-validate.mjs content
```

- `--site` takes the site id or `shortName`; with one site on the token it is picked automatically.
- `--collections blog,authors` limits the export (collection slug, id or display name).
- `--locales en,pt-BR` limits locales (tag or `cmsLocaleId`).
- `--rpm` sets the request rate: 60 on Starter/Basic, 120 on CMS/Business/Ecommerce (Premium) site plans, custom on
  Enterprise. Limits are per token. A `429` waits for `Retry-After` (usually 60 s) and retries.
- The raw responses are saved in `content/_raw/webflow/` (no token inside), so the API is hit once.

### What the script calls

| step | endpoint | notes |
|---|---|---|
| sites | `GET /v2/sites`, `GET /v2/sites/{site_id}` | `locales.primary/secondary[]` with `cmsLocaleId`, `tag`, `subdirectory` (some doc examples wrap it in `locales.value`: handled) |
| collections | `GET /v2/sites/{site_id}/collections` | `{collections:[{id, displayName, singularName, slug}]}` |
| schema | `GET /v2/collections/{collection_id}` | `fields[]: {id, slug, displayName, type, isRequired, validations}`; `validations.options[{id,name}]` (Option), `validations.collectionId` (Reference/MultiReference) |
| staged items | `GET /v2/collections/{id}/items?limit=100&offset=N&cmsLocaleId=…` | all items incl. drafts and archived |
| live items | `GET /v2/collections/{id}/items/live?…` | published versions |

Item: `{id, cmsLocaleId, lastPublished, lastUpdated, createdOn, isArchived, isDraft, fieldData:{name, slug, <field-slug>: …}}`.
Status: `lastPublished` set and `isDraft:false` → published; `isDraft:true` with `lastPublished` → published with unsaved
draft changes (`sourceStatus: "published-with-draft-changes"`, the live version is exported); `lastPublished:null` →
draft; `isArchived` → draft + `archived: true`.

### Field type mapping

| Webflow | normalized | value |
|---|---|---|
| PlainText, Email, Phone, User | text | string |
| RichText | richtext | HTML (`rawFormat: webflow-html`); `<wf-component>` instances and custom-code embeds (`data-rt-embed-type`) are reported |
| Image / MultiImage | image (`multiple`) | `{url, alt, assetId: fileId}` |
| File | file | `{url, name, assetId}` |
| Link, VideoLink | link | URL string |
| Number | number | |
| DateTime | date | ISO |
| Switch | boolean | |
| Color | color | string |
| Option | option | option id → `slugify(name)`; options keep `sourceId` |
| Reference / MultiReference | reference / multi-reference | item id(s); `to` = target collection |
| ExtFileRef / unknown | json | reported under "Unknown field types" |

Old item URLs are `/<collection-slug>/<item-slug>` (secondary locales: `/<subdirectory>/…`). `--routes` builds the
redirect candidates (`:locale` = the old subdirectory).

## Path B — CSV export (no token)

In the Designer: **CMS panel → collection → Export** (or select items → Export). The whole collection is exported,
archived items included, **only for the locale currently selected**. Webflow documents no plan restriction for
export (CSV *import* may need a plan with enough CMS items). Export each collection, then run all files together:

```bash
node webflow-csv-import.mjs "exports/" --out content \
  --old-routes "blog-posts=/blog/:slug" --routes "blog-posts=/blog/:slug" \
  --locales "653ad57de882f528b32e810e=en"
```

File name pattern: `<Site> - <Collection> - <collectionId>.csv`. Columns observed in real exports (Webflow does
not publish a spec): first column = the Name field under its display name (often renamed: "Title"), then `Slug,
Collection ID, Locale ID, Item ID, Archived, Draft, Created On, Updated On, Published On`, then custom fields in
field order. Older exports may lack `Archived/Draft` or `Locale ID`: columns are matched by name.

Value formats: dates in JS `Date.toString()` form (`Sun Feb 15 2026 00:22:44 GMT+0000 (Coordinated Universal Time)`);
booleans `true/false`; Option = option **name**; Reference = target **slug**; Multi-reference = slugs joined by `; `
(sometimes `;` or `,`); Image/File = one CDN URL (`cdn.prod.website-files.com/<siteId>/<fileId>_<name>`), no alt;
Multi-image = URLs joined by `; `; Rich text = HTML with `id=""` noise (removed).

Inference rules: values that match ≥ 60% of another CSV's slugs (≥ 34% when the column is named like that
collection) become references; image/file URLs, HTML, dates, numbers, booleans, colors and links are detected; a
text column with few repeated values becomes an option. Everything inferred is flagged. Fix mistakes with
`--schema schema.json`:

```json
{ "Blog Posts": { "Author": { "type": "reference", "to": "authors" }, "Kind": { "type": "option" }, "Read Time": { "type": "number" } } }
```

Limits of the CSV path: no alt text, no option ids, no field validations or required flags, one locale per file,
rich text embeds come back as HTML that must be reviewed, and assets still point to the Webflow CDN (download them
before the site is unpublished: `_assets.json` lists every URL).

## After the export

- `content-validate.mjs content` (add `--check-assets` to HEAD every asset URL).
- Assets live on `cdn.prod.website-files.com` / `uploads-ssl.webflow.com`: mirror them before cancelling the plan.
- Webflow Ecommerce products, Memberships users and form submissions are out of scope.
