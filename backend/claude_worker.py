"""Private pipe lifetime owns the Claude process tree, including after app death."""
import json
import os
import subprocess
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'runtime' / 'hermes'))
from hermes_cli.local_runtime.processes import spawn_server


def main():
    request = json.loads(sys.stdin.buffer.readline())
    # Reuse the pinned Hermes launcher: suspended start, assign to a Windows
    # kill-on-close job, then resume. Parent death also closes the owner handle.
    child, job = spawn_server(
        [request['executable'], *request['args']], cwd=request['cwd'],
        stdin=subprocess.PIPE, stdout=sys.stdout, stderr=sys.stderr,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0,
        start_new_session=os.name != 'nt',
    )

    def forward():
        try:
            for line in sys.stdin.buffer:
                child.stdin.write(line)
                child.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            if child.poll() is None:
                if job is not None:
                    job.close()
                else:
                    import signal
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    threading.Thread(target=forward, daemon=True).start()
    try:
        return child.wait()
    finally:
        if job is not None:
            job.close()


if __name__ == '__main__':
    # main has waited for the child and closed its job. The daemon input forwarder
    # may still hold stdin's buffered lock; interpreter teardown must not join it.
    os._exit(main())
