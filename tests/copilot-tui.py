#!/usr/bin/env python3
"""Drive one interactive Copilot CLI turn in a pseudo-terminal.

Usage: copilot-tui.py <workdir> <message> [copilot args...]

Starts `copilot` in <workdir> on a pty, answers the terminal queries its TUI
sends, trusts the folder and declines the app install offer if asked, types
<message> once the prompt is up, and waits until the session's events.jsonl
records the end of that turn. It accepts a pending ask_user or permission
prompt with Enter, then stops the CLI. Prints the events.jsonl path.
COPILOT_HOME must be set; the caller isolates it.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

TIMEOUT = float(os.environ.get("TUI_TIMEOUT", "240"))
SETTLE = float(os.environ.get("TUI_SETTLE", "6"))

ANSI = re.compile(rb"\x1b\[[0-9;?<>=$]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\")

REPLIES = [
    (re.compile(rb"\x1b\[\?(\d+)\$p"), lambda m: b"\x1b[?" + m.group(1) + b";2$y"),
    (re.compile(rb"\x1b\[\?u"), lambda m: b"\x1b[?0u"),
    (re.compile(rb"\x1b\]10;\?(\x07|\x1b\\)"), lambda m: b"\x1b]10;rgb:cccc/cccc/cccc\x1b\\"),
    (re.compile(rb"\x1b\]11;\?(\x07|\x1b\\)"), lambda m: b"\x1b]11;rgb:1111/1111/1111\x1b\\"),
    (re.compile(rb"\x1b\]4;(\d+);\?(\x07|\x1b\\)"), lambda m: b"\x1b]4;" + m.group(1) + b";rgb:8080/8080/8080\x1b\\"),
    (re.compile(rb"\x1b\[>0?q"), lambda m: b"\x1bP>|xterm(1)\x1b\\"),
    (re.compile(rb"\x1b\[\?996n"), lambda m: b"\x1b[?997;1n"),
    (re.compile(rb"\x1b\[0?c"), lambda m: b"\x1b[?62;22c"),
    (re.compile(rb"\x1b\[6n"), lambda m: b"\x1b[1;1R"),
]


def debug(*parts):
    if os.environ.get("TUI_DEBUG"):
        sys.stderr.write("tui %.1f: %s\n" % (time.time(), " ".join(str(p) for p in parts)))


def events_of(state, before):
    fresh = [d for d in os.listdir(state) if d not in before and not d.startswith(".")] if os.path.isdir(state) else []
    return [p for p in (os.path.join(state, d, "events.jsonl") for d in fresh) if os.path.exists(p)]


def read_events(path):
    try:
        with open(path) as f:
            return [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError):
        return []


def main():
    workdir, message, args = sys.argv[1], sys.argv[2], sys.argv[3:]
    state = os.path.join(os.environ["COPILOT_HOME"], "session-state")
    before = set(os.listdir(state)) if os.path.isdir(state) else set()
    resume = next((a.split("=", 1)[1] for a in args if a.startswith("--resume=")), None)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        os.execvp("copilot", ["copilot", *args])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))

    start = time.time()
    last_output = start
    typed = 0
    enters = 0
    trusted = False
    declined = False
    dialog_at = 0
    prompt_at = None
    path = None
    answered = set()
    prior = 0
    buf = b""
    log = open(os.environ["TUI_LOG"], "ab") if os.environ.get("TUI_LOG") else None
    try:
        while time.time() - start < TIMEOUT:
            ready, _, _ = select.select([fd], [], [], 0.5)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                last_output = time.time()
                if log:
                    log.write(chunk)
                buf = (buf + chunk)[-16384:]
                for pattern, reply in REPLIES:
                    for m in pattern.finditer(chunk):
                        os.write(fd, reply(m))
            screen = ANSI.sub(b"", buf)
            if not trusted and b"trust the files in this folder" in screen:
                time.sleep(0.5)
                os.write(fd, b"\r")
                trusted = True
                dialog_at = time.time()
                debug("trusted folder")
                continue
            # A fresh home offers to install the Copilot app; Enter would accept.
            if not declined and b"Install it now?" in screen:
                time.sleep(0.5)
                os.write(fd, b"n")
                declined = True
                dialog_at = time.time()
                debug("declined the app install offer")
                continue
            if prompt_at is None and b"? help" in screen:
                prompt_at = time.time()
                debug("prompt up")
            # The footer is not redrawn after a dialog closes, so wait from the
            # later of the first prompt and the last dialog.
            if not typed and prompt_at and time.time() - max(prompt_at, dialog_at) > SETTLE:
                os.write(fd, message.encode())
                time.sleep(0.5)
                os.write(fd, b"\r")
                typed = time.time()
                debug("typed message")
            if not typed:
                continue
            if path is None:
                if resume:
                    path = os.path.join(state, resume, "events.jsonl")
                    prior = sum(1 for e in read_events(path) if e.get("type") == "user.message")
                else:
                    found = events_of(state, before)
                    path = found[0] if found else None
            events = read_events(path) if path else []
            users = [i for i, e in enumerate(events) if e.get("type") == "user.message"]
            if len(users) <= prior:
                # An Enter that lands while the TUI is still loading is dropped.
                if time.time() - typed > 15 and enters < 4:
                    os.write(fd, b"\r")
                    enters += 1
                    typed = time.time()
                    debug("pressed Enter again")
                continue
            tail = events[users[prior]:]
            for e in tail:
                kind = e.get("type", "")
                key = json.dumps(e.get("data", {}), sort_keys=True)[:200]
                if kind in ("permission.requested", "user_input.requested", "elicitation.requested") and key not in answered:
                    answered.add(key)
                    os.write(fd, b"\r")
            ends = [e for e in tail if e.get("type") == "assistant.turn_end"]
            starts = [e for e in tail if e.get("type") == "assistant.turn_start"]
            if ends and len(ends) == len(starts) and time.time() - last_output > 4:
                debug("turn ended")
                break
    finally:
        debug("stopping")
        try:
            os.kill(pid, signal.SIGTERM)
            deadline = time.time() + 10
            while not os.waitpid(pid, os.WNOHANG)[0]:
                if time.time() > deadline:
                    os.kill(pid, signal.SIGKILL)
                # The child cannot exit while its terminal output is undrained.
                if select.select([fd], [], [], 0.25)[0]:
                    try:
                        os.read(fd, 65536)
                    except OSError:
                        os.close(fd)
                        os.waitpid(pid, 0)
                        break
        except (ProcessLookupError, ChildProcessError):
            pass
    if path is None or not os.path.exists(path):
        sys.stderr.write("no session events found; screen tail: %s\n" % ANSI.sub(b"", buf)[-800:].decode("utf8", "replace"))
        sys.exit(1)
    print(path)


if __name__ == "__main__":
    main()
