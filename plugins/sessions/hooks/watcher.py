#!/usr/bin/env python3
"""The file watch of the sessions mod: a process that sleeps in the kernel until a path it watches changes.

    watcher.py watch-paths --how kqueue|inotify [--depth N] PATH...   the mod's own file watch, where Claude watches
                                                          nothing for it, and other plugins' ($.sessions.watchCommand)
                                                          (watch_paths())

A file of its own, small on purpose: a session no classic.SessionStart reaches keeps one of these running for as long
as it lives (and another plugin's own watch a second one), and python compiles the file it is started with at every
start, so what such a process holds in memory grows with that file. With the launcher's 2,000 lines it held 14 MB; with
these, 6 MB (macOS, python 3.9). So nothing is imported here but what the watch uses, and each kernel watch imports its
own (select; ctypes for inotify alone). launcher.py imports the watch classes from here for the window's watcher
(launcher.py watch).
"""
import os
import sys
import time


# --- watching files: the window's watcher (launcher.py watch) and the mod's own watch ----------------------------------
#
# Both sleep in the kernel until a path they watch changes. A watch is armed with the paths to watch (arm: exactly those
# from then on, armed again after each look) and waits (wait) until one of them changes, the time runs out, or the
# process it was told to follow (its parent) ends, which raises Ended; so does its output's reader going away, where it
# watches its output (a pipe or a socket), with no write needed to find out.
# - kqueue (macOS, the BSDs): one descriptor per path. A folder's says entries came or went, but not that bytes reached
#   a file already there (and $.fs.write creates a file first, then writes it), so each file gets its own (a write, a
#   truncation); a path whose file was replaced (written beside it and renamed over it) gets the new file's. The
#   parent's end is a kernel event too (NOTE_EXIT), and so is the output's reader going (EV_EOF on its write filter).
# - inotify (Linux): one watch per folder, which reports every change of every file in it (a file is watched through its
#   folder). The parent's end comes through its pidfd (Linux 5.3, Python 3.9), the output's reader going as an error
#   on its end (POLLERR on a pipe, POLLHUP on a socket).
# - poll (the window's watcher alone, where neither can be had): a look every POLL_S.
# Whatever the kernel says, the mod's own watch also looks every PARENT_CHECK_S at whether its parent is still the one it
# started with (watch_paths): one that isn't (it ended and the process was handed to another, init or a subreaper) ends it.

POLL_S = 0.2
PARENT_CHECK_S = 10.0
KQUEUE_NOTES = ('KQ_NOTE_WRITE', 'KQ_NOTE_EXTEND', 'KQ_NOTE_ATTRIB', 'KQ_NOTE_DELETE', 'KQ_NOTE_RENAME')
# Paths that went away between a look and the watch: watched again once they're back
MISSING = (FileNotFoundError, NotADirectoryError, PermissionError)


class Ended(Exception):
    pass


# A pipe or a socket: the outputs whose reader can go away (a file or a terminal has none to lose)
def is_stream(fd):
    from stat import S_ISFIFO, S_ISSOCK
    try:
        mode = os.fstat(fd).st_mode
    except OSError:
        return False
    return S_ISFIFO(mode) or S_ISSOCK(mode)


class KqueueWatch:
    def __init__(self, parent=None, output=None):
        import select
        self.select = select
        self.kq = select.kqueue()
        self.notes = 0
        for name in KQUEUE_NOTES:
            self.notes |= getattr(select, name)
        self.held = {}  # path: (descriptor, inode)
        if parent:
            # Fails when the parent is gone already
            self.kq.control([select.kevent(parent, select.KQ_FILTER_PROC, select.KQ_EV_ADD | select.KQ_EV_ONESHOT, select.KQ_NOTE_EXIT)], 0)
        # The output's write filter, edge-triggered (EV_CLEAR: once per change of the room in it, not while there's
        # room): it sets EV_EOF when the reader goes, and is otherwise none of the watch's business
        if output is not None and is_stream(output):
            self.kq.control([select.kevent(output, select.KQ_FILTER_WRITE, select.KQ_EV_ADD | select.KQ_EV_CLEAR)], 0)

    def count(self):
        return len(self.held)

    def arm(self, paths):
        s = self.select
        for path in [p for p in self.held if p not in paths]:
            os.close(self.held.pop(path)[0])
        for path in paths:
            try:
                inode = os.stat(path).st_ino
            except OSError:
                inode = None
            held = self.held.get(path)
            if held and held[1] != inode:
                os.close(self.held.pop(path)[0])
                held = None
            if inode is None or held:
                continue
            try:
                fd = os.open(path, getattr(os, 'O_EVTONLY', os.O_RDONLY))
            except MISSING:
                continue
            try:
                self.kq.control([s.kevent(fd, s.KQ_FILTER_VNODE, s.KQ_EV_ADD | s.KQ_EV_CLEAR, self.notes)], 0)
            except OSError:
                os.close(fd)
                continue
            self.held[path] = (fd, os.fstat(fd).st_ino)

    # True when something changed; seconds=None waits for as long as it takes
    def wait(self, seconds):
        s = self.select
        end = None if seconds is None else time.time() + seconds
        while True:
            events = self.kq.control(None, 64, None if end is None else max(0.0, end - time.time()))
            if any(e.filter == s.KQ_FILTER_PROC or (e.filter == s.KQ_FILTER_WRITE and e.flags & s.KQ_EV_EOF) for e in events):
                raise Ended()
            if any(e.filter != s.KQ_FILTER_WRITE for e in events):
                return True
            # Nothing, or only the output's room changing (the reader read)
            if end is not None and time.time() >= end:
                return False


class InotifyWatch:
    # IN_MODIFY, IN_CLOSE_WRITE, IN_MOVED_FROM, IN_MOVED_TO, IN_CREATE, IN_DELETE, IN_DELETE_SELF, IN_MOVE_SELF
    MASK = 0x2 | 0x8 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800

    def __init__(self, parent=None, output=None):
        import ctypes
        import select
        self.ctypes = ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        init, self.add, self.rm = libc.inotify_init1, libc.inotify_add_watch, libc.inotify_rm_watch
        init.argtypes, self.add.argtypes, self.rm.argtypes = [ctypes.c_int], [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32], [ctypes.c_int, ctypes.c_int]
        self.fd = init(os.O_NONBLOCK | os.O_CLOEXEC)
        if self.fd < 0:
            raise OSError(ctypes.get_errno(), 'inotify_init1 (fs.inotify.max_user_instances?)')
        self.held = {}  # folder: (watch, inode)
        self.poll = select.poll()
        self.poll.register(self.fd, select.POLLIN)
        self.pidfd, self.output = None, None
        if parent:
            # Without one (an older kernel or Python), watch_paths's look every PARENT_CHECK_S is all
            try:
                self.pidfd = os.pidfd_open(parent)
                self.poll.register(self.pidfd, select.POLLIN)
            except (AttributeError, OSError):
                self.pidfd = None
        # A pipe whose reader is gone reports an error (POLLERR) on its writer's end, a socket a hang-up (POLLHUP)
        if output is not None and is_stream(output):
            self.output = output
            self.poll.register(output, 0)

    def count(self):
        return len(self.held)

    def arm(self, paths):
        import errno
        from stat import S_ISDIR
        folders = {}
        for path in paths:
            try:
                st = os.stat(path)
            except OSError:
                continue
            if S_ISDIR(st.st_mode):
                folders[path] = st.st_ino
        for path, (wd, inode) in list(self.held.items()):
            if folders.get(path) != inode:
                self.rm(self.fd, wd)
                del self.held[path]
        for path, inode in folders.items():
            if path in self.held:
                continue
            wd = self.add(self.fd, os.fsencode(path), self.MASK)
            if wd < 0:
                err = self.ctypes.get_errno()
                if err in (errno.ENOENT, errno.ENOTDIR, errno.EACCES):
                    continue
                raise OSError(err, 'inotify_add_watch %s (fs.inotify.max_user_watches?)' % path)
            self.held[path] = (wd, inode)

    def wait(self, seconds):
        end = None if seconds is None else time.time() + seconds
        while True:
            left = None if end is None else max(0.0, end - time.time())
            ready = [fd for fd, _ in self.poll.poll(None if left is None else int(left * 1000))]
            if (self.pidfd is not None and self.pidfd in ready) or (self.output is not None and self.output in ready):
                raise Ended()
            if self.fd in ready:
                try:
                    while os.read(self.fd, 65536):
                        pass
                except OSError:
                    pass
                return True
            if end is not None and time.time() >= end:
                return False


class PollWatch:
    def count(self):
        return 0

    def arm(self, paths):
        pass

    def wait(self, seconds):
        time.sleep(POLL_S if seconds is None else min(seconds, POLL_S))
        return True


WATCHES = {'kqueue': KqueueWatch, 'inotify': InotifyWatch, 'poll': PollWatch}


# --- the mod's own watch --------------------------------------------------------------------------------------------
#
# watcher.py watch-paths --how kqueue|inotify [--depth N] PATH...: the file events of a session no classic.SessionStart
# reached (a plugin ahead of sessions sent it on past it, or the session was updated in place), whose Claude watches
# nothing for the mod. Its mod runs one with $.process.spawn over the paths SessionStart would hand Claude (watchPaths in
# watch.ts) and reads its lines as classic.FileChanged: `ready<TAB>how<TAB>pid<TAB>watched` once every watch is armed,
# then `add|change|unlink<TAB>path` for each file that came, changed or went. Another plugin runs one of its own the same
# way, over its own paths with --depth 0, from the command $.sessions.watchCommand builds (docs/plugin-contract.md).
#
# Each PATH is a folder (its files and its subfolders' to --depth levels below it) or a file; one that's missing is
# waited for in its folder. After an event it waits SETTLE_S for the rest of a burst, then looks at every file it watches
# (one stat each) and prints what differs from the last look (a file whose path has a tab or a line break, which no line
# could carry, never). Which watch to use is the platform's (fileWatch in hooks/platform): one that can't be had, or a
# limit of the system it meets (descriptors for kqueue, which needs one per file, raised here to what the system allows;
# fs.inotify.max_user_instances or max_user_watches), ends it with the reason on stderr and exit code 1, and the mod
# reads on its short timer meanwhile. It never outlives its reader or its parent: it ends when its parent (the session's
# process) ends, killed outright or not (the kernel's event), when its parent is no longer the one it started with (a
# look every PARENT_CHECK_S), and when its output's reader goes (the mod's loop ended or its module reloaded: the
# kernel's event, or a write that fails); and the mod ends it when a SessionStart comes and Claude watches the paths
# itself.

SETTLE_S = 0.02
FILES_WANTED = 10240


# The files under the watched folders and the watched files, {path: (inode, mtime, size)}, and the folders to watch: the
# watched ones and their subfolders to depth, and the folder of a watched file (or folder) that's missing
def path_snapshot(roots, depth):
    files, folders = {}, set()

    def walk(folder, left):
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return
        folders.add(folder)
        for e in entries:
            try:
                st = e.stat(follow_symlinks=False)
                is_dir = e.is_dir(follow_symlinks=False)
            except OSError:
                continue
            if is_dir:
                if left > 0:
                    walk(e.path, left - 1)
            else:
                files[e.path] = (st.st_ino, st.st_mtime_ns, st.st_size)

    for p in roots:
        if os.path.isdir(p):
            walk(p, depth)
            continue
        try:
            st = os.stat(p)
            files[p] = (st.st_ino, st.st_mtime_ns, st.st_size)
        except OSError:
            pass
        if os.path.isdir(os.path.dirname(p)):
            folders.add(os.path.dirname(p))
    return files, folders


def path_changes(old, new):
    out = [('add' if p not in old else 'change', p) for p, sig in sorted(new.items()) if old.get(p) != sig]
    out += [('unlink', p) for p in sorted(old) if p not in new]
    return [(kind, p) for kind, p in out if '\t' not in p and '\n' not in p]


def emit(lines):
    try:
        for fields in lines:
            sys.stdout.write('\t'.join(fields) + '\n')
        sys.stdout.flush()
    except OSError:
        os._exit(0)  # the reader is gone: the mod's loop ended, or its module reloaded


# A descriptor per watched file for kqueue: the soft limit raised as far as the system lets it (a session's own is
# usually high already)
def raise_file_limit():
    try:
        import resource
        soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        for want in (FILES_WANTED, 4096, 1024):
            if soft < want and (hard == resource.RLIM_INFINITY or hard >= want):
                try:
                    resource.setrlimit(resource.RLIMIT_NOFILE, (want, hard))
                    return
                except (ValueError, OSError):
                    continue
    except (ImportError, ValueError, OSError):
        pass


# The arguments, read by hand: argparse alone would add a megabyte to what every watcher holds. None: not a command line
# this takes
class WatchArgs:
    def __init__(self, how, depth, paths):
        self.how, self.depth, self.paths = how, depth, paths


def watch_paths_args(argv):
    how, depth, paths = None, 2, []
    i = 0
    while i < len(argv):
        word = argv[i]
        if word in ('--how', '--depth'):
            if i + 1 >= len(argv):
                return None
            if word == '--how':
                how = argv[i + 1]
            else:
                try:
                    depth = int(argv[i + 1])
                except ValueError:
                    return None
            i += 2
            continue
        if word.startswith('--how='):
            how = word[6:]
        elif word.startswith('--depth='):
            try:
                depth = int(word[8:])
            except ValueError:
                return None
        elif word.startswith('-') and word != '-':
            return None
        else:
            paths.append(word)
        i += 1
    if how not in ('kqueue', 'inotify') or not paths:
        return None
    return WatchArgs(how, depth, paths)


def watch_paths(argv):
    args = watch_paths_args(argv)
    if args is None:
        sys.stderr.write('usage: watcher.py watch-paths --how kqueue|inotify [--depth N] PATH...\n')
        return 2
    roots = [os.path.abspath(p) for p in args.paths]
    parent = os.getppid()
    if parent <= 1:
        return 0
    try:
        if args.how == 'kqueue':
            raise_file_limit()
            w = KqueueWatch(parent, sys.stdout.fileno())
        else:
            w = InotifyWatch(parent, sys.stdout.fileno())

        # Armed again after every look: a folder or file that came, went or was replaced (renamed over) is watched as
        # it is now (inotify watches the folders alone)
        def arm(files, folders):
            w.arm(set(folders) | (set(files) if args.how == 'kqueue' else set()))

        files, folders = path_snapshot(roots, args.depth)
        arm(files, folders)
        emit([('ready', args.how, str(os.getpid()), str(w.count()))])
        while os.getppid() == parent:
            if not w.wait(PARENT_CHECK_S):
                continue
            time.sleep(SETTLE_S)
            w.wait(0)
            new, new_folders = path_snapshot(roots, args.depth)
            arm(new, new_folders)
            if new_folders != folders:
                # What came in a folder before its watch was armed is in a look taken after it
                new, new_folders = path_snapshot(roots, args.depth)
                arm(new, new_folders)
            folders = new_folders
            changes = path_changes(files, new)
            files = new
            if changes:
                emit(changes)
    except Ended:
        return 0
    except (AttributeError, ImportError, OSError) as err:
        sys.stderr.write("watcher.py watch-paths: can't watch with %s: %s\n" % (args.how, err))
        return 1
    except KeyboardInterrupt:
        return 0
    return 0


def main(argv):
    if argv[:1] == ['watch-paths']:
        return watch_paths(argv[1:])
    sys.stderr.write('usage: watcher.py watch-paths --how kqueue|inotify [--depth N] PATH...\n')
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
