"""App-owned wire contract over Hermes's existing session request transport."""
from typing import Literal
from pydantic import Field
from tui_gateway.contracts.base import JsonValue, Result
from tui_gateway.contracts.server_requests import ServerRequestParams
from tui_gateway.contracts.registry import server_request


class McpRequest(ServerRequestParams):
    operation: Literal['list', 'tools', 'call', 'goal', 'app', 'app-list', 'app-link', 'app-todo', 'app-todo-update', 'chat-coordinate', 'chat-history', 'history-query', 'background-process', 'output', 'image', 'document', 'web', 'publish', 'preview']
    connection: str | None = None
    tool: str | None = None
    arguments: dict[str, JsonValue] = Field(default_factory=dict)


class McpResult(Result):
    value: JsonValue = None
    error: str | None = None


server_request('trismegistus.mcp', params=McpRequest, result=McpResult,
               doc='Use a desktop-owned MCP connection in the requesting session.')


class WorkRequest(ServerRequestParams):
    operation: Literal['begin', 'finish', 'board', 'inspect']
    name: str | None = None
    arguments: dict[str, JsonValue] = Field(default_factory=dict)
    request_id: str | None = None
    patch_paths: list[str] | None = Field(default=None, max_length=1000)
    lease: str | None = None
    result: JsonValue = None
    uncertain: bool = False
    refused: bool = False


class WorkResult(Result):
    value: JsonValue = None
    enabled: bool = False
    lease: str | None = None
    error: str | None = None


server_request('trismegistus.work', params=WorkRequest, result=WorkResult,
               doc='Coordinate a side job action through the desktop owner.')
