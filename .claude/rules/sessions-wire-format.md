---
paths:
  - "plugins/sessions/hooks/**"
  - "plugins/sessions/types/**"
---

# sessions: the wire format stays as it is

Sessions running different versions of the `sessions` mod share stored data and send each other notices, and launchers already running in terminal windows keep reading the same file format. These names are in Spanish on purpose and must stay byte-identical:

- `$.store` keys and the fields inside stored values: `estado:<id>` (with `creado`, `empezado`, `terminado`, `motivo`, `respuesta`, `pregunta`, `modelo`, `contexto`, `version`, `protocolo`), `visto:`, `titulo:`, `esperando:`, `reiniciada:`, `revividas:`, `lista`, `instalada`, `vistaUso` (`periodo`, `alcance`), `fijado`, `fijadoAuto` (`ids`, `soltadas`), `reapertura` (`at`, `normalDesde`).
- The notices between sessions (`sessions:focus-panel:7f3a`, `sessions:ask-stop:7f3a`, `sessions:stop-answer:7f3a`, `sessions:rename:7f3a`) and their payload fields and values (`desde`, `tema`, `detalle`, `sessionId`, `accion`, `volvio`, `nombre`).
- The launcher's file lines (`comando=`, `id=`, `titulo=`, `carpeta=`), the folders `~/.claude/mods/sessions-visor`, `sessions-uso`, `sessions-bin`, and `uso.py`'s cache and output keys (`hoy`, `hora`, `dias`, `horas`).

Never translate or rename them. New keys and fields can have English names. If a notice changes meaning, raise `PROTOCOL` in `register.tsx` and send it only to sessions whose stored `protocolo` is high enough, the way the existing notices do.
