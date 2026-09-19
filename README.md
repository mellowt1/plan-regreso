# Plan de regreso

A one-page, read-only status app for Eduardo: what we are working on together, the plan, and how it is going. Spanish, mobile first, no framework, no build step for the page itself.

Live: https://mellowt1.github.io/plan-regreso/

## How it works

- `index.html` is the whole app. It asks for a PIN once, derives a key (PBKDF2, 200k iterations, SHA-256), decrypts `data.json` (AES-GCM 256) and renders. The key is kept in the browser so the PIN is typed once per device.
- `data.json` is the only content committed. It is ciphertext. The public repo and URL leak nothing without the PIN.
- `content/plan.json` is the plaintext source. It is gitignored. Keep a copy outside the repo as well.
- `sw.js` caches the shell and the last `data.json` so the page opens on patchy internet.

## Updating the content (about 2 minutes)

1. Edit `content/plan.json` (tasks, log entry, fund saved, phases).
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
