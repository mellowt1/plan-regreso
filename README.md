# Plan de regreso

A one-page, read-only status app for Eduardo: what we are working on together, the plan, and how it is going. Spanish and English (ES | EN switch, remembered per device; Spanish phones open in Spanish), mobile first, no framework, no build step for the page itself.

Live: https://mellowt1.github.io/plan-regreso/

## How it works

- `index.html` is the whole app. It asks for a PIN once, derives a key (PBKDF2, 200k iterations, SHA-256), decrypts `data.json` (AES-GCM 256) and renders. The key is kept in the browser so the PIN is typed once per device.
- `data.json` is the only content committed. It is ciphertext. The public repo and URL leak nothing without the PIN.
- `content/plan.json` is the plaintext source. It is gitignored. Keep a copy outside the repo as well.
- `sw.js` caches the shell and the last `data.json` so the page opens on patchy internet.

## Live data, editing and notifications (since 2026-09-25)

- The plan now lives on a Cloudflare Worker, `plan-regreso.paul-o-a04.workers.dev` (code in `worker/`, config in `wrangler.toml`, KV namespace PLAN_REGRESO). It stores only the ciphertext. `data.json` stays as the fallback.
- **Editing:** open `/admin.html` on your phone, sign in with the PIN and the admin token. Tick tasks, reorder, add log entries, add money to the fund, set prices, then Save. "Notify Dad" is ticked by itself when his next task changes.
- **Notifications:** Dad taps "Sí, avísame" on his page. On iPhone he first adds the page to the Home Screen. The push says only "la pelota está de tu lado"; nothing from the plan goes through the push service.
- **Secrets:** `ADMIN_TOKEN`, `SUB_KEY` and the VAPID keys are Worker secrets, with a copy in `plan-regreso-secrets.txt` outside the repo. `SUB_KEY` is also inside the encrypted plan (`push.key`), so only someone with the PIN can sign a phone up.
- **From the terminal:** `node sync.mjs pull` gets the latest edits into `content/plan.json`; `node sync.mjs push [--notify]` sends it back. Both need `PLAN_PIN`; push also needs `PLAN_ADMIN`. Pull before editing plan.json by hand.
- **Deploying the Worker:** `npx wrangler deploy` in this folder.

## Updating the content (old way, still works for data.json)

1. Edit `content/plan.json` (tasks, log entry, fund saved, phases). Every text is `{ "es": "...", "en": "..." }`; write both. A plain string still works and shows in both languages.
2. Set `updated` to today.
3. Run the build with the PIN:

```
PLAN_PIN=xxxxxx node build.mjs
PLAN_PIN=xxxxxx node build.mjs --check
```

4. Commit `data.json` and push `main`. GitHub Pages redeploys in about a minute.

## PIN

Never commit the PIN, never put it in this README. Send link and PIN to Eduardo in two separate messages. Changing the PIN: run the build with the new PIN and push. Every device then asks for the PIN again.

## Local preview

```
node serve.mjs
```

Opens on http://localhost:8080.

## Conventions

- Everything Eduardo reads is in Spanish, short and plain.
- No dashes as punctuation in any text.
- No invented numbers or dates. Leave a field empty rather than guess.
- Immigration status details and household expenses are not in this app.
