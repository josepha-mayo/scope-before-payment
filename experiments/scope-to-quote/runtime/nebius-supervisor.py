"""Pinned stdlib subprocess supervisor. No provider, credential or app startup.
Interface matches the existing admitted transport. CLI requires explicit command.
"""
import argparse
import json
import os
import pathlib
import signal
import subprocess
import sys
import time


def supervise(args):
    run = pathlib.Path(args.run_dir)
    run.mkdir(mode=0o700)  # exclusive: never resume/reuse a supervision attempt
    if run.resolve() != run or run.stat().st_uid != os.getuid() or run.stat().st_mode & 0o077:
        raise ValueError('directory')
    received = None
    child = None
    output_complete = True
    started = time.monotonic()
    def retire(sig, _):
        nonlocal received
        if received is None:
            received = sig
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    previous = {sig: signal.signal(sig, retire) for sig in [signal.SIGTERM, signal.SIGINT]}
    state = 'unknown'
    try:
        # stdout/stderr must never reach UI/shell logs. Bound disk output through
        # a pipe consumed by this supervisor, killing the group on overflow.
        import selectors
        if received is not None:
            raise InterruptedError('retired')
        child = subprocess.Popen(args.command, cwd=args.cwd, start_new_session=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                 env=os.environ.copy())
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        count = 0
        stop_at = None
        while selector.get_map() or child.poll() is None:
            now = time.monotonic()
            if received is not None or now - started >= args.timeout:
                if stop_at is None:
                    state = 'terminated' if received is not None else 'timeout'
                    stop_at = now
                    try:
                        os.killpg(child.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
            if stop_at is not None and now - stop_at >= args.grace:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for key, _ in selector.select(0.02):
                part = os.read(key.fileobj.fileno(), 65536)
                if not part:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                else:
                    count += len(part)
                    if count > args.max_output_bytes:
                        output_complete = False
                        if stop_at is None:
                            state, stop_at = 'output_bound', now
            if stop_at is not None and now - stop_at > args.grace + 2 and child.poll() is not None:
                # A descendant retaining the output pipe is not clean output.
                output_complete = False
                break
        code = child.wait()
        if received is not None:
            state = 'terminated'
        elif state == 'unknown':
            state = 'finished'
        receipt = {'terminal': True, 'state': state, 'childReturnCode': code,
                   'outputComplete': output_complete, 'receivedSignal': received}
        fd = os.open(run / 'receipt.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(receipt, f, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        fd = os.open(run, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return 0 if code == 0 and state == 'finished' and output_complete else 1
    finally:
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()
        for sig, old in previous.items():
            signal.signal(sig, old)


def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument('--run-dir', required=True)
    p.add_argument('--cwd', required=True)
    p.add_argument('--source', action='append', default=[])
    p.add_argument('--timeout', type=float, required=True)
    p.add_argument('--grace', type=float, required=True)
    p.add_argument('--max-output-bytes', type=int, required=True)
    p.add_argument('command', nargs=argparse.REMAINDER)
    args = p.parse_args(argv)
    if args.command[:1] == ['--']:
        args.command = args.command[1:]
    if not args.command or not 0.01 <= args.timeout <= 240 or not 0.01 <= args.grace <= 2 or not 1 <= args.max_output_bytes <= 131072:
        return 1
    return supervise(args)


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception:
        sys.exit(1)
