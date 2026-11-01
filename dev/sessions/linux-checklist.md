# Checking the sessions plugin on a Linux desktop

The Linux mode (windows found by process, switching through the launcher) was tested on macOS with
`SESSIONS_PORTABLE=1`. On a real Linux desktop, check these once, in about ten minutes. Write down the distribution,
the desktop (X11 or Wayland) and the terminal app.

1. **Install and set up:** `claude plugin marketplace add mcavuoti/claude-plugins`, `claude plugin install sessions@mcavuoti`,
   open `claude`, run `/sessions setup` and check it names your shell and file. Open a new terminal: `type ccc`.
2. **Status line:** a new session shows model · effort · folder · branch · context % · cost (needs `jq`).
3. **Panel:** in a project folder run `ccc`, create two sessions (type a task, or `n`), open one. The panel is on the
   right (or above the prompt in a narrow window). `shift+→` focuses it, `←` goes back.
4. **Switch in place:** select the other session, Enter: the same window shows it in about a second, and its panel has
   the keyboard. Enter back. Then `a`: the same window shows the agent view.
5. **Inside the agent view:** open a session from the agent view, then Enter on another row in its panel: the window
   switches to that session.
6. **Another window:** open a second terminal with `ccc`, open the other session there. From the first window, Enter on
   that session. X11 with `wmctrl` or `xdotool`: the second window comes forward. Otherwise: the first window shows it too.
7. **New window:** in a plain `claude` session (no launcher), Enter on a background session: a new terminal window opens
   showing it. If not, the panel says it couldn't (check `$TERMINAL` and that one of the listed terminals is installed).
8. **Restart your own session (`u` on your row):** the window comes back to it and says "Restarted".
9. **Rename (`r`) and the field lock:** arrows don't leave the field, Esc cancels, Enter renames.
10. **Version and folders from `/proc`:** a session on an older Claude shows ↑ after an update; `a` brings an existing
    agent view for the same folder forward (or opens one in place).

Anything off: note what you pressed, what the window showed, and the output of `ps -A -o pid=,tty=,command= | grep -E 'claude|visor'`.
