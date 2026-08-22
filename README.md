# waiver-page

Static liability waiver signing page. No build step — `index.html` is served as-is, with `config.json` alongside it for the values that change without a code edit, and `waiver-content.json` for the waiver's legal text. Together those two files make the project company-agnostic: pointing it at a different company is a matter of editing `config.json` and swapping `waiver-content.json`, not touching code. The reference deployment described below is for Alaska Unique Adventures (AUA).

This document describes what the backend does today and what a future admin/owner dashboard would need.

## Frontend

- `index.html` — the signing page. Loads `config.json` and `waiver-content.json` at runtime (via `fetch`, so it must be served over `http(s)://`, not opened as a local file) before it will let anyone submit.
- `config.json` — plain-text, not secret:
  ```json
  {
    "companyName": "Alaskan Adventure Haven",
    "companyUrl": "https://alaskanadventurehaven.com/",
    "ownerEmail": "tgralex@gmail.com",
    "supabaseUrl": "https://ibcjvmsxhyzhvsncxvmb.supabase.co",
    "supabaseAnonKey": "sb_publishable_...",
    "minorAgeThreshold": 18
  }
  ```
  `supabaseAnonKey` is the publishable/anon key — safe to expose client-side by design. `companyName`/`companyUrl` drive the clickable header at the top of the page and the browser tab title; `companyUrl` is optional — omit it and the header renders as plain (non-linked) text. Editing this file (no redeploy of code needed) changes the owner's BCC address, the minor-age cutoff, the branding, or repoints the whole page at a different Supabase project.
- `waiver-content.json` — the waiver's legal text (`title`, `intro`, `items`, `closing`), read by `index.html` for the on-page terms and by `waiver-pdf.js` for the client-side "Download my waiver" PDF. The Edge Function (below) reads its own copy of this same file, bundled alongside its source — see "Setup for a new deployment". This is the one file to replace wholesale when adapting the project for a different company's waiver text.

## Supabase project

**Every deployment of this page — including each contributor's own fork or environment — should use its own dedicated Supabase project and its own mailing/SMTP setup.** Don't share a project across unrelated apps; don't share SMTP credentials with someone else's mailbox. `supabase/schema.sql` and `supabase/functions/wv-submit-waiver/index.ts` in this repo are exactly what's live today, checked in so a new contributor can stand up their own project without needing this written up again. See "Setup for a new deployment" below.

(The reference deployment this was built against currently lives on `Tigrans_DB_kmm`, project ref `ibcjvmsxhyzhvsncxvmb` — shared with unrelated apps in that org. That's an artifact of how this was originally built, not the intended pattern going forward.)

### Setup for a new deployment

1. Create a new Supabase project (free tier is enough).
2. Run `supabase/schema.sql` against it — SQL Editor in the Dashboard, or `supabase db execute -f supabase/schema.sql` via the CLI. This creates the `wv` schema, the `waiver_signatures` table with RLS enabled and no policies, and the `public.submit_waiver_signature` RPC.
3. Deploy the Edge Function: `supabase functions deploy wv-submit-waiver` (from `supabase/functions/wv-submit-waiver/index.ts`), making sure `waiver-content.json` is deployed alongside it (copy it into `supabase/functions/wv-submit-waiver/` first, or otherwise ensure it's bundled — the function reads it via `Deno.readTextFile` at cold start, relative to its own source). Leave `verify_jwt` on — it should require the anon/publishable key like any other `supabase-js` call.
4. Set your own mailbox's SMTP secrets on the project (see "Email" below for the exact names) — get an app password / SMTP credentials from whatever email account you want submissions to send from.
5. Update `config.json` at the repo root with this project's URL, its publishable/anon key (Project Settings → API), the owner email you want BCC'd on every submission, and this company's name/URL. Edit `waiver-content.json` with this company's own waiver text.
6. Submit a test waiver through the page and confirm: the row lands in `wv.waiver_signatures`, and the email with the attached PDF arrives at both the test "customer" address and the owner's BCC.

## Database: `wv.waiver_signatures`

| column | type | nullable | notes |
|---|---|---|---|
| `id` | uuid | no | PK, `gen_random_uuid()` |
| `name` | text | no | participant print name |
| `email` | text | yes | participant email — also the "To" address for the emailed copy |
| `signed_date` | date | no | |
| `signature_image` | text | no | participant signature, PNG as a `data:image/png;base64,...` string |
| `dob` | date | yes | |
| `phone` | text | yes | |
| `address` | text | yes | |
| `city` | text | yes | |
| `state` | text | yes | USPS abbreviation, from the state dropdown |
| `zip` | text | yes | |
| `minor_info` | text | yes | free text: minor name(s) and DOB(s), only when signing on behalf of a minor |
| `guardian_print_name` | text | yes | |
| `guardian_dob` | date | yes | used client-side to enforce the guardian is at or above `minorAgeThreshold` |
| `guardian_signature_image` | text | yes | guardian signature, same `data:image/png;base64,...` format |
| `guardian_date` | date | yes | |
| `created_at` | timestamptz | no | `now()`, server-assigned |

RLS is **enabled with no policies** — nothing is readable or writable directly by the `anon`/`authenticated` roles. All access goes through the `SECURITY DEFINER` RPC and the edge function below, both of which run with elevated privilege.

### Why a table in `wv` and an RPC in `public`

PostgREST (and any `supabase-js` client, including from an Edge Function) only exposes the `public` schema by default. There's no tool access in this environment to change that project-level "exposed schemas" setting, so a direct `wv.waiver_signatures` insert from a schema-scoped client fails with `Invalid schema: wv`. The workaround: keep the table in `wv`, and add `public.submit_waiver_signature(...)` — a `SECURITY DEFINER` function (owned by `postgres`, which bypasses RLS) that inserts into `wv.waiver_signatures`. Both the raw RPC and the edge function call this same function.

## PDF: built from the pieces we have, not stored anywhere

There is no PDF file stored in the database or in Supabase Storage. The `wv-submit-waiver` Edge Function reconstructs the PDF **on every submission**, in-memory, from:
1. The waiver's fixed legal text — read from `waiver-content.json` (bundled with the function, see "Setup for a new deployment"), the same file `index.html` and `waiver-pdf.js` read for the on-page terms and the client-side PDF.
2. The row's own fields (name, dob, phone, address, city/state/zip, signed_date, and the guardian fields when present).
3. The two signature PNGs (`signature_image`, `guardian_signature_image`), embedded as images via `pdf-lib`.

The generated bytes are attached directly to the outgoing email and then discarded. Because nothing is persisted, the same PDF can always be regenerated later from the row alone — which is exactly what a future "download PDF" admin feature would do (see below), rather than looking up a stored file.

## Edge Function: `wv-submit-waiver`

Deployed on the `Tigrans_DB_kmm` project, `verify_jwt: true` (so it requires the anon/publishable key, same as any other `supabase-js` call). Called by the page via `supabaseClient.functions.invoke("wv-submit-waiver", { body: {...} })` instead of the frontend calling the RPC directly, so insert + PDF + email happen as one server-side step.

Request body: the same fields as the table above (camelCase), plus `ownerEmail` — passed in by the frontend from `config.json`, **not** looked up server-side. That's deliberate: it avoids an IDOR-style risk where a client could pass an arbitrary existing row id and get a copy of someone else's signed waiver — this function only ever acts on data submitted in the same request, never a lookup by id.

Steps:
1. Validate required fields (`name`, `signedDate`, `signatureImage`) and email formats.
2. Insert via `submit_waiver_signature(...)`.
3. Build the PDF (best-effort — a PDF failure is logged but doesn't fail the request, since the data is already saved).
4. Email the PDF (best-effort, same reasoning) — only if the submission included an email.

### Email: customer + BCC owner

One email per submission, sent via SMTP (`denomailer`):
- **To:** the participant's own email (`payload.email`) — no email is sent at all if this is blank.
- **Bcc:** `payload.ownerEmail`, i.e. whatever `config.json`'s `ownerEmail` was at submit time.
- **From:** `Alaska Unique Adventures <CONTACT_EMAIL_FROM>` — display name is hardcoded, the address comes from a secret.
- **Attachment:** the freshly generated PDF, or none if PDF generation failed.

SMTP settings are read from Supabase Edge Function secrets — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_SECURE`, `CONTACT_EMAIL_FROM` — set per-project via Dashboard → Project Settings → Edge Functions → Secrets, or `supabase secrets set` via the CLI. Set your own mailbox's credentials here; don't reuse someone else's. If they're unset, the function logs `wv_email_skipped_no_smtp_config` and skips sending — the submission still succeeds and is still saved.

(The reference deployment currently reuses SMTP secrets from an unrelated function in the shared `Tigrans_DB_kmm` project. A dedicated mailbox, `support@alaskanadventurehaven.ingenioussoftwaresolutions.com`, has been created to replace that but isn't wired in yet — needs its host/port/username/password set as secrets.)

## Potential expansion: owner dashboard page

Not built. A second page where the owner logs in to see all waivers, search/filter, and download PDFs would need, roughly:

- **Auth**: Supabase Auth (email/password or magic link) for the owner — currently there is no authenticated user at all in this project, everything runs through the anon key plus server-side functions.
- **Read access**: either (a) RLS policies on `wv.waiver_signatures` scoped to an authenticated "owner" role, or (b) another `SECURITY DEFINER` RPC / Edge Function gated on `auth.uid()`, mirroring the write-side pattern already in place. Given the schema-exposure constraint above, (b) is more consistent with what's already built.
- **Search/filter**: by name, email, or date range — straightforward query params against the RPC/function once auth is sorted.
- **PDF download**: reuse `buildWaiverPdf` from `wv-submit-waiver` (would want to factor it into shared code) to regenerate on demand — no need to start storing PDFs for this, per the "built from the pieces we have" section above.
- **Open questions for whoever picks this up**: Who besides the owner should have access — is a single shared login acceptable, or does each staff member need their own? Should this live in the same repo as a second page, or as a separate app against the same Supabase project?
