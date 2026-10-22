"""Whole-file knowledge must survive Windows stat/fstat timestamp semantics."""
import hashlib
import json
import os
import time
from unittest.mock import patch

from tools import file_tools, file_tools_read_tracking as tracking, terminal_tool


def test_existing_file_full_read_write_and_stale_guards(tmp_path):
    file = tmp_path / 'existing.txt'
    file.write_text('created\n')
    time.sleep(0.03)
    file.write_text('first\nsecond\n')
    task = 'windows-read-version'
    terminal_tool.record_session_cwd(task, str(tmp_path))
    read = json.loads(file_tools.read_file_tool(str(file), task_id=task))
    assert not read.get('error') and not read.get('truncated')
    written = json.loads(file_tools.write_file_tool(str(file), 'updated\n', task_id=task))
    assert not written.get('error') and file.read_text() == 'updated\n', written
    stamp = file.stat()
    file.write_text('changed\n')
    os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    blocked = json.loads(file_tools.write_file_tool(str(file), 'must not overwrite', task_id=task))
    assert blocked.get('stale_write_blocked') and file.read_text() == 'changed\n'
    paged = tmp_path / 'paged.txt'
    paged.write_text('line one\nline two\n')
    file_tools.read_file_tool(str(paged), limit=1, task_id=task)
    assert json.loads(file_tools.write_file_tool(str(paged), 'no', task_id=task)).get('stale_write_blocked')
    digest = hashlib.file_digest
    def change_during_read(stream, algorithm):
        result = digest(stream, algorithm)
        file.write_text('altered\n')
        return result
    with patch.object(hashlib, 'file_digest', side_effect=change_during_read):
        assert tracking._file_version(str(file)) is None
