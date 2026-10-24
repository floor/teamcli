#!/usr/bin/env python3
"""Runs a command on a pseudo-terminal and prints what it writes. For isolated test homes ONLY:
it refuses unless HOME is under /tmp or /private/tmp, so it can never stand in for the owner's
terminal on the real setup."""
import os, sys
if not os.environ.get('HOME', '').startswith(('/tmp/', '/private/tmp/')):
    sys.exit('as-terminal: refused outside an isolated /tmp home')
pid, fd = os.forkpty()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
while True:
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data); sys.stdout.flush()
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
