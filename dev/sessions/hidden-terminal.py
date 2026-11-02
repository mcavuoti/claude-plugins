"""Run a command in a private pseudo-terminal and drive it with keys, without touching any real window.

Used to test the sessions mod end to end: open `claude`, `claude attach <id>`, `claude agents` or the launcher
(`hooks/visor.sh`) in a hidden terminal, send keys, and dump the screen as text.

Keys arrive through a FIFO, separated by `|`. Plain text is typed as is; these names send special keys:
ENTER, ESC, UP, DOWN, LEFT, RIGHT, TAB, SRIGHT (shift+right, the shortcut that focuses the panel), BS, CTRLU, CTRLT.
DUMP writes the current screen to `<log>.screen`, with [brackets] around reverse-video cells (the focus ring).
Send several keys in one write, separated by `|` (`printf 'DOWN|DOWN|c'`): two writes in a row can be read as one
chunk, and then `DOWNDOWN` arrives as text and is typed as is.
The process exits when the command ends, after HT_SECONDS seconds (1800 by default: set it higher for a long run), or
on SIGHUP. To end a viewer (`claude attach`), send it SIGHUP (`pkill -HUP -f 'hidden-terminal.py <fifo>'`) rather than
typing /exit: /exit there only detaches, and the viewer drops into the agent view, which lists every session of the
account with its new-session prompt focused (typing there starts a session).

Needs pyte (`python3 -m venv venv && venv/bin/pip install pyte`).

Run it with a clean environment: started from inside a Claude session, the child would inherit that session's
variables (CLAUDE_CODE_CHILD_SESSION and others), register as a child, skip saving its transcript and borrow
the parent's name. To load a development copy of a plugin instead of the installed one, pass it with --settings
(settings.json `env` overrides the process environment):

    mkfifo t.fifo; exec 3<>t.fifo
    env -i HOME="$HOME" USER="$USER" PATH="$PATH" TERM=xterm-256color LANG=en_US.UTF-8 \\
      venv/bin/python hidden-terminal.py t.fifo out \\
      claude --settings '{"env":{"CLAUDE_CODE_PLUGIN_DIRS":"/path/to/plugins/sessions"}}'
    printf 'SRIGHT' > t.fifo; printf 'r' > t.fifo; printf 'DUMP' > t.fifo; cat out.screen

Writing to the FIFO blocks if nothing reads it: check the process is alive (`pgrep -f hidden-terminal.py`)
before sending DUMP.
"""
import fcntl
import os
import pty
import select
import struct
import sys
import termios
import time

import pyte

fifo, log, command = sys.argv[1], sys.argv[2], sys.argv[3:]
# The size: 230 x 45 unless HT_COLS / HT_ROWS say otherwise (to try narrow windows)
ROWS, COLS = int(os.environ.get('HT_ROWS', '45')), int(os.environ.get('HT_COLS', '230'))
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
keys_in = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)
deadline = time.time() + int(os.environ.get('HT_SECONDS', '1800'))
special = {'ENTER': b'\r', 'ESC': b'\x1b', 'DOWN': b'\x1b[B', 'UP': b'\x1b[A', 'LEFT': b'\x1b[D', 'RIGHT': b'\x1b[C',
           'TAB': b'\t', 'CTRLT': b'\x14', 'SRIGHT': b'\x1b[1;2C', 'BS': b'\x7f', 'CTRLU': b'\x15'}


def dump():
    lines = []
    for y in range(ROWS):
        row = screen.buffer[y]
        text, inverse = '', False
        for x in range(COLS):
            cell = row[x]
            if cell.reverse and not inverse:
                text += '['
                inverse = True
            if not cell.reverse and inverse:
                text += ']'
                inverse = False
            text += cell.data
        if inverse:
            text += ']'
        lines.append(text.rstrip())
    with open(log + '.screen', 'w') as out:
        out.write('\n'.join(lines))


while time.time() < deadline:
    ready, _, _ = select.select([fd, keys_in], [], [], 0.5)
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        stream.feed(data)
    if keys_in in ready:
        for part in os.read(keys_in, 4096).decode().split('|'):
            if part == 'DUMP':
                dump()
            elif part:
                os.write(fd, special.get(part, part.encode()))
            time.sleep(0.15)
