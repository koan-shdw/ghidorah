"""App tools can be immediately callable without exposing unavailable tools."""
from tools.registry import registry
from tools import tool_search as search


def test_eager_schema_and_catalog_share_the_same_available_scope(monkeypatch):
    def definition(name):
        schema = {'name': name, 'description': 'Test capability', 'parameters': {'type': 'object', 'properties': {}}}
        registry.register(name=name, toolset='mcp-eager-test', schema=schema, handler=lambda args, **kw: '{}')
        return {'type': 'function', 'function': schema}

    direct, lazy = definition('eager_probe'), definition('lazy_probe')
    config = search.ToolSearchConfig.from_raw({'eager': ['eager_probe', 'unavailable_probe']})
    monkeypatch.setattr(search, 'load_config_readonly', lambda: config)
    assembled = search.assemble_tool_defs([direct, lazy], config=config)
    assert direct in assembled.tool_defs
    assert lazy not in assembled.tool_defs
    assert all(t['function']['name'] != 'unavailable_probe' for t in assembled.tool_defs)
    assert search._deferrable_in([direct, lazy]) == [lazy]
    assert search.assemble_tool_defs([lazy], config=config).deferred_count == 1


def test_eager_configuration_does_not_affect_default_classification():
    config = search.ToolSearchConfig.from_raw({'eager': 'invalid scalar'})
    assert config.eager_tools == frozenset()
    assert search.ToolSearchConfig.from_raw(None).eager_tools == frozenset()
