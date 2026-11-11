# Seed Gallery — Project Instructions

This public file contains shared project guidance. Keep personal plans, test budgets, API keys, and local test records out of this file and the repository.

## Communication and code

- Communicate with the project owner in Traditional Chinese. Keep technical terms in English.
- Write code comments, variable names, and commit messages in English.
- Clarify requirements when a material ambiguity could change the result. Do not expand scope on your own.
- Preserve the configured human Git identity. Do not add AI authorship, co-authorship, or generated-by attribution.

## Product purpose

- A friendly, mobile-first browser interface for creating images and videos, and for general chat, through Runware. It is meant for nontechnical users, including older adults.
- Keep jargon and first-use setup to a minimum. Let photos and results be the focus of the screen.
- Do not ship features that look usable but are not implemented.

## Provider scope

- Use Runware only. Do not add another provider (fal, Runway, etc.) or a project-owned generation backend without an explicit request.
- Do not build multi-provider abstractions, fallbacks, or provider registries in anticipation of a future switch.
- Documenting Runware model capabilities and parameters is fine; do not grow it into a generic provider framework.

## Privacy and data flow

- The browser calls Runware directly. Never collect prompts, photos, results, or keys on any project-owned service.
- Users supply their own API Key. Never place a real Key in source, logs, URLs, tests, test reports, or deployment artifacts.
- Explain data flow accurately: prompts and reference images go to Runware and necessary upstream services during generation. Browser storage does not imply that API providers retain nothing. Do not claim zero retention, full offline operation, or absolute security without applicable evidence.
- The home page links to the repository and gives an easy-to-understand data-flow explanation.

## First use and settings

- There is no site account system. The first entry is called 「設定服務」, not a login.
- After a Key validates, save it in the current browser by default and reuse it on later visits.
- Settings offer Key replacement and removal, data clearing, and the money display preference. Destructive actions must state their scope clearly and resist accidental taps.
- Keep the first-use tour available to both guests and users who validate an API Key, and remember dismissal on the current device.

## Balance and cost display

- A single setting, 「顯示餘額與費用」, controls the balance, per-generation estimates, and actual costs. It defaults to on.
- `?costs=hidden` only sets the initial value when no preference has been saved; it never overrides a saved choice and must never carry an API Key.
- When off, hide all of these amounts on every screen (home, menus, workspaces, full view, history). Hiding is presentation only and does not change billing.
- The preference is stored per device and is not synced by a shared Key.
- Label estimates as estimates and never mix them with actual cost or balance. If a balance query fails, never show 0 or a made-up number.

## Generation workspaces

- Settings, submission, and results stay in one workspace. On phones, switch between editing and results instead of splitting a narrow screen into columns.
- All selected models receive the same prompt and reference photos. Clearly show how many models, how many results per model, and the total.
- Shared settings (ratio, quality/resolution, count) use plain wording and visual hints. Model-specific parameters live in collapsed advanced settings for the selected models.
- Never silently ignore unsupported parameters, photos, or capability differences, and never crop results to fake a requested ratio.
- After submission, each job shows its own status and result. Keep successful results and allow failed jobs to be retried independently.
- Never submit a paid generation twice because of repeated taps, reloads, or reconnection. Querying an existing task must not create a new charge.
- With reference photos, edit those photos; never fall back to text-only generation that ignores them. For video, a photo is the starting frame.
- Image and video workspaces each remember their last models and settings on the current device. New works do not inherit prompts or photos unless the user explicitly brings an image into a new work.

## Inspiration

- 「給我一點靈感」 returns four ideas that respect the current text and photos. When photos are present, the model must see them.
- Selecting an idea fills the prompt; it never starts a generation automatically.
- Taste history comes only from final prompts of submitted jobs, stays on the current device, and follows work deletion and backup restore.

## Works and local data

- In the interface, a session is called 「我的作品」 or similar plain wording. A work can hold several generation batches; there is no hidden multi-turn edit context.
- Full view offers download and 「用這張圖開始新作品」, which creates a new work with the image as a reference and does not submit or charge.
- Save works, prompts, needed settings, and the actual media in IndexedDB until the user deletes them. Do not rely on provider URLs that may expire.
- Offer backup export and restore. Each device stores its own data.
- Warn that clearing browser data, changing devices, or storage eviction can lose data. Do not present browser storage as a permanent backup.
- Preserve saved work, media, and settings when changing application code. Existing `img-generator` IndexedDB and localStorage identifiers are compatibility names; changing the repository name does not require changing them.

## Layout and visual direction

- Portrait phones first, for both iPhone and Android. Desktop uses a centered, width-limited single column.
- Adapt to different widths without fixed heights that cut off content. Account for on-screen keyboards, touch targets, and safe areas.
- Runs in the browser; app-store distribution is not a goal.
- Bright background, large text, clear buttons, and a few soft colors.

## Development and delivery

- Use `npm ci` to install dependencies, `npm run dev` for local development, `npm test` for unit tests, `npm run build` for production validation, and `npm run test:e2e` for browser flows.
- Run checks relevant to the change and report anything that could not be verified. Distinguish desktop emulation from real iPhone/Android testing.
- Do not assume SDK or browser reconnection works; verify background switching, reopening, and result recovery when a change touches them.
- Do not run paid generation tests without a separately authorized budget.
- Keep paths portable. Use relative paths or repository-aware configuration instead of hard-coded local workspace paths.
- Start a local server after changes so the owner can review the result. Push, pull requests, and remote branch changes require the owner's explicit consent.
- Only `dist/` is deployed to GitHub Pages; do not copy local planning files or credentials into it.

## Local additions

Git-ignored local instruction files (such as `CLAUDE.local.md`) and the `.local/` directory may hold the owner's private notes and test records. Never commit them or copy their contents into public files.
