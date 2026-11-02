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
13. **Sections that fold, children, marks and ⚙n:** `/sessions section A` in one session, `c` on its row: one line
    `▸ A · 1` that Enter unfolds, the focus on it and then on the row. A child (another plugin's `parent`) is two columns
    in; a badge and a status line line up with the other rows; `⚙1` while a session runs a background shell.
14. **ccc tell from cron or a systemd timer:** `/sessions tell on` in a background session, then from a job with no
    terminal, `ccc tell <its id> "ping"`: it prints `queued` and a status file, and the session takes it as a turn of its
    own (the status file then says `delivered`). `ccc tell --wait <its id> "ping"` waits and prints `delivered`.
15. **ccc section:** with one window showing a session of the project, `ccc section A` from another terminal in the
    project folder puts that session in section A (the panels draw it within 3 s); with two windows showing sessions of
    the project it asks for `--session <name>`.
16. **Notifications:** set `waitPushMinutes` to 1 in `/config`, have a background session ask you something (a
    question, a permission) and leave it waiting: about two minutes later you get one notification naming it, through
    your terminal's notifications (kitty, Ghostty) or your `Notification` hooks, and none after that for the same wait.
    `/sessions status` says what PushNotification and the notification channel answered.

Anything off: note what you pressed, what the window showed, and the output of `ps -A -o pid=,tty=,command= | grep -E 'claude|visor'`.
