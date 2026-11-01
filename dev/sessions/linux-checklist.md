# Checking the sessions plugin on a Linux desktop

The Linux mode (windows found by process, switching through the launcher) was tested on macOS with
`SESSIONS_PORTABLE=1`. On a real Linux desktop, check these once, in about ten minutes. Write down the distribution,
the desktop (X11 or Wayland) and the terminal app.

1. **Install and set up:** `claude plugin marketplace add mcavuoti/claude-plugins`, `claude plugin install sessions@mcavuoti`,
   open `claude`, run `/sessions setup` and check it names your shell and file. Open a new terminal: `type ccc`, and
   `ls ~/.claude/mods/sessions-data/bin` shows `ccc` and `statusline.sh`.
2. **Status line:** a new session shows model · effort · folder · branch · context % · cost (needs `jq`).
3. **ccc in an empty folder:** in a trusted project folder with no sessions, `ccc` shows the Name prompt. Type a name and
   Enter: "Starting …", then the new session with its panel on the right (or above the prompt in a narrow window),
   the panel holding the keyboard. `shift+→` focuses it, `←` goes back. `/sessions status` says it started.
4. **ccc with sessions:** create a second session (`n`), exit the window (Ctrl+Z or close it), open a new terminal in
   the folder and run `ccc`: the top session of the panel opens there, the panel on the row after it. `ccc <name>` opens
   the other one; `ccc --agents` the agent view.
5. **One window per project:** with one window showing a session of the project, run `ccc` in a second terminal. X11
   with `wmctrl` or `xdotool`: the first window comes forward and the second says the project is already open there.
   Otherwise: the second says it couldn't bring it forward and opens the next session itself. `ccc --new` always opens
   in the second one.
6. **Switch in place:** select the other session, Enter: the same window shows it in about a second, and its panel has
   the keyboard. Enter back. Then `a`: the same window shows the agent view.
7. **Inside the agent view:** open a session from the agent view, then Enter on another row in its panel: the window
   switches to that session.
8. **Another window:** open a second terminal with `ccc --new`, open the other session there. From the first window,
   Enter on that session. X11 with `wmctrl` or `xdotool`: the second window comes forward. Otherwise: the first window
   shows it too.
9. **New window:** in a plain `claude` session (no launcher), Enter on a background session: a new terminal window opens
   showing it. If not, the panel says it couldn't (check `$TERMINAL` and that one of the listed terminals is installed).
10. **Restart your own session (`u` on your row):** the window comes back to it and says "Restarted".
11. **Rename (`r`) and the field lock:** arrows don't leave the field, Esc cancels, Enter renames.
12. **Version and folders from `/proc`:** a session on an older Claude shows ↑ after an update; `a` brings an existing
    agent view for the same folder forward (or opens one in place).

Anything off: note what you pressed, what the window showed, and the output of `ps -A -o pid=,tty=,command= | grep -E 'claude|visor'`.
