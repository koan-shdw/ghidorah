import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMcpImport} from '../app/upstream/mcp-import';
test('MCP import accepts approved formats and preserves quoted Windows paths',()=>{
 assert.deepEqual(parseMcpImport('claude mcp add local -- "C:\\Program Files\\node.exe" "C:\\Projects\\server.js"'),[{name:'local',config:{command:'C:\\Program Files\\node.exe',args:['C:\\Projects\\server.js']}}]);
 assert.deepEqual(parseMcpImport('https://mcp.example.com/mcp'),[{name:'example',config:{url:'https://mcp.example.com/mcp'}}]);
 assert.deepEqual(parseMcpImport('npx -y @example/server-local'),[{name:'local',config:{command:'npx',args:['-y','@example/server-local']}}]);
 assert.deepEqual(parseMcpImport('{"mcpServers":{"remote":{"type":"http","url":"https://example.com/mcp"}}}'),[{name:'remote',config:{transport:'http',url:'https://example.com/mcp'}}]);
 assert.equal(parseMcpImport('not a server'),null);
});
