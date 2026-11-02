---
paths:
  - "plugins/sessions/types/**"
  - "plugins/sessions/hooks/register.tsx"
  - "plugins/sessions/docs/plugin-contract.md"
  - "plugins/sessions/tests/contract.test.tsx"
---

# sessions: `$.sessions`, the contract other plugins call

`sessions` adds a noun to `$` (`engine.create` in `hooks/register.tsx`) that other plugins call. How to use it and how it evolves: `plugins/sessions/docs/plugin-contract.md`.

- **Written once.** The contract's types live only in `plugins/sessions/types/index.d.ts`, from `SessionsApi` down; the docs describe the methods and never restate the shapes. Only the noun's own types carry the `Sessions` prefix; the rest of that file and `PluginState` are private to `sessions`.
- **One list of methods.** `METHODS` (`satisfies Record<SessionsMethod, 1>`) is what `contract()` serves; the golden list in `tests/contract.test.tsx` is the one place the method names are written out. A new method gets an entry there and a test.
- **Within an api, changes only add**: methods, optional input fields, output fields. Removing or renaming a method, or changing what a field means or its shape, raises `SessionsApi` (the d.ts literal and `SESSIONS_API`) in the same commit that updates and releases every plugin here that calls it.
- **Methods** take one plain-data argument and answer expected failures as `{ ok: false, reason }` (`busy` when the lock wasn't taken). They work before the mod starts in the session (`ready: false`; the data folder from `$.env`), never submit, ask or move the focus (they run lent in the caller's hook), use absolute paths only, and run every command from a folder that exists (`runSafe`).
- **`engine.create` does nothing but add the noun.** A throw there unloads the whole mod. The `$` built there can't be handed to a function (the validator refuses it), so the methods reach it through closures over it, and `$.env.get` there needs each variable's name written out.
- **Calls only, both ways.** Other plugins never hook `sessions.*` events nor read its state, store or files; `sessions` never names a particular plugin, and its data stays its own.
- **No tokens.** `sessions` never calls `$.model.*`, `$.agent.spawn`, `$.agent.register` or `$.tool.register`, and never appends a row the model reads, with one exception: `ccc tell`, in a background session the person opted in with `/sessions tell on`, submits a script's text as a turn of its own (`$.prompt.submit` from the mod's own timer, framed as sent by a script). No `$.sessions` method does. Its one `$.tool.call` is PushNotification, from its own timers (no row of it reaches the model).
