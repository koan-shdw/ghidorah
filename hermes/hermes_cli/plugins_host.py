"""Activity-scoped tool dispatch for hosts running plugin code outside an agent turn."""
from contextlib import contextmanager
from contextvars import ContextVar

_dispatcher = ContextVar('plugin_host_tool_dispatcher', default=None)


def get_host_tool_dispatcher():
    return _dispatcher.get()


@contextmanager
def plugin_tool_dispatcher(callback):
    """Bind callback(ctx, tool_name, args, kwargs); exceptions never fall back to raw dispatch."""
    token = _dispatcher.set(callback)
    try:
        yield
    finally:
        _dispatcher.reset(token)
