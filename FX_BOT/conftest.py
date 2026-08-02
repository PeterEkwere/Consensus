"""Root conftest.

Its mere presence at the project root puts this directory on ``sys.path`` (pytest
prepend import mode), so ``import domain`` / ``import config`` / ``import
signal_engine`` resolve without an installed package or a src layout.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
