"""Private PTY transport for MailHarbor's fixed Agy login command (Linux only).

No shell, transcript, or network client. The Node controller validates the pinned
executable and accepts only one authorization code while the login prompt is open.
"""
import errno
import fcntl
import os
import select
import signal
import struct
import subprocess
import sys
import termios


def main():
    master, slave = os.openpty()
    # Keep authorization URLs on one line, and never echo the pasted code.
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 4096, 0, 0))
    settings = termios.tcgetattr(slave)
    settings[3] &= ~(termios.ECHO | termios.ECHONL)
    termios.tcsetattr(slave, termios.TCSANOW, settings)

    def terminal():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    child = None
    stopping = False

    def stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, stop)
    try:
        child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave,
                                 stderr=slave, preexec_fn=terminal, close_fds=True)
        os.close(slave)
        slave = None
        while not stopping:
            readable, _, _ = select.select([master, sys.stdin.fileno()], [], [], 0.1)
            for fd in readable:
                try:
                    data = os.read(fd, 8192)
                except OSError as error:
                    if fd == master and error.errno == errno.EIO:
                        data = b''
                    else:
                        raise
                if not data:
                    stopping = True
                    break
                target = sys.stdout.fileno() if fd == master else master
                while data:
                    data = data[os.write(target, data):]
            if child.poll() is not None:
                break
    finally:
        if child is not None:
            # Agy owns a distinct session; include its companion processes even
            # if the CLI already exited. Parent EOF also tears down this group.
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        os.close(master)
        if slave is not None:
            os.close(slave)
    return child.returncode if child and child.returncode and not stopping else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # Raw exceptions can contain process arguments or environment paths.
        sys.stderr.write('Login terminal unavailable.\n')
        sys.exit(1)
