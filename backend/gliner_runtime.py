"""GLiNER2.5-Decide's pinned local runtime, with its own dependency environment.
The lock was written from PyPI's published hashes (scripts/lock-from-pypi.py); the model is pinned by revision.
"""
from pathlib import Path
import sys

SOURCE = Path(__file__).resolve().parent
sys.path.insert(0, str(SOURCE))
import local_classifier_runtime as runtime  # noqa: E402

runtime.configure('GLiNER', SOURCE / 'gliner-requirements.txt', SOURCE / 'gliner-model.json')

if __name__ == '__main__':
    runtime.run()
