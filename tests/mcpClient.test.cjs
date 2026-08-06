const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
	DataifyMcpClient,
	McpProtocolError,
	buildMcpUrl,
	parseToolArguments,
} = require('../dist/nodes/DataifyMcp/mcpClient.js');

function jsonResponse(body, headers = {}, statusCode = 200) {
	return {
		body: JSON.stringify(body),
		headers,
		statusCode,
	};
}

describe('DataifyMcpClient', () => {
	it('initializes the session and sends the initialized notification', async () => {
		const requests = [];
		const responses = [
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'dataify', version: '1.0.0' },
					},
				},
				{ 'mcp-session-id': 'session-123' },
			),
			{ body: '', headers: {}, statusCode: 202 },
		];
		const client = new DataifyMcpClient(async (request) => {
			requests.push(request);
			return responses.shift();
		});

		const result = await client.initialize();

		assert.equal(result.serverInfo.name, 'dataify');
		assert.equal(requests.length, 2);
		assert.deepEqual(JSON.parse(requests[0].body), {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-11-25',
				capabilities: {},
				clientInfo: { name: 'n8n-nodes-dataify', version: '0.1.0' },
			},
		});
		assert.deepEqual(JSON.parse(requests[1].body), {
			jsonrpc: '2.0',
			method: 'notifications/initialized',
		});
		assert.equal(requests[1].headers['Mcp-Session-Id'], 'session-123');
		assert.equal(requests[1].headers['Mcp-Protocol-Version'], '2025-11-25');
	});

	it('lists every page of tools in one initialized session', async () => {
		const requests = [];
		const responses = [
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'dataify', version: '1.0.0' },
					},
				},
				{ 'Mcp-Session-Id': 'session-list' },
			),
			{ body: '', headers: {}, statusCode: 202 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 2,
				result: {
					tools: [{ name: 'google_search', description: 'Search Google' }],
					nextCursor: 'next-page',
				},
			}),
			jsonResponse({
				jsonrpc: '2.0',
				id: 3,
				result: { tools: [{ name: 'task_status', description: 'Get task status' }] },
			}),
		];
		const client = new DataifyMcpClient(async (request) => {
			requests.push(request);
			return responses.shift();
		});

		const tools = await client.listTools();

		assert.deepEqual(
			tools.map((tool) => tool.name),
			['google_search', 'task_status'],
		);
		assert.deepEqual(JSON.parse(requests[3].body).params, { cursor: 'next-page' });
		assert.equal(requests[2].headers['Mcp-Session-Id'], 'session-list');
	});

	it('calls a tool and parses a streamable HTTP SSE response', async () => {
		const requests = [];
		const responses = [
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'dataify', version: '1.0.0' },
					},
				},
				{ 'mcp-session-id': 'session-call' },
			),
			{ body: '', headers: {}, statusCode: 202 },
			{
				body: [
					'event: message',
					'data: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"ok"}],"structuredContent":{"taskId":"abc"}}}',
					'',
				].join('\n'),
				headers: { 'content-type': 'text/event-stream' },
				statusCode: 200,
			},
		];
		const client = new DataifyMcpClient(async (request) => {
			requests.push(request);
			return responses.shift();
		});

		const result = await client.callTool('google_search', { q: 'n8n' });

		assert.deepEqual(result.structuredContent, { taskId: 'abc' });
		assert.deepEqual(JSON.parse(requests[2].body).params, {
			name: 'google_search',
			arguments: { q: 'n8n' },
		});
	});

	it('throws protocol errors returned by the server', async () => {
		const responses = [
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					error: { code: -32600, message: 'invalid request', data: { field: 'params' } },
				},
				{},
				400,
			),
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		await assert.rejects(
			client.initialize(),
			(error) =>
				error instanceof McpProtocolError &&
				error.code === -32600 &&
				error.message === 'invalid request',
		);
	});

	it('treats MCP tool error results as failed executions', async () => {
		const responses = [
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 1,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'dataify', version: '1.0.0' },
					},
				},
				{ 'mcp-session-id': 'session-error' },
			),
			{ body: '', headers: {}, statusCode: 202 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 2,
				result: { isError: true, content: [{ type: 'text', text: 'tool is not allowed' }] },
			}),
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		await assert.rejects(client.callTool('paid_tool', {}), /tool is not allowed/);
	});
});

describe('Dataify MCP helpers', () => {
	it('normalizes server URLs without duplicating the MCP path', () => {
		assert.equal(buildMcpUrl('http://localhost:7780/'), 'http://localhost:7780/mcp');
		assert.equal(buildMcpUrl('https://api.example.com/mcp'), 'https://api.example.com/mcp');
	});

	it('parses object and JSON string tool arguments', () => {
		assert.deepEqual(parseToolArguments({ q: 'n8n' }), { q: 'n8n' });
		assert.deepEqual(parseToolArguments('{"q":"n8n"}'), { q: 'n8n' });
		assert.deepEqual(parseToolArguments(''), {});
		assert.throws(() => parseToolArguments('["not-an-object"]'), /JSON object/);
		assert.throws(() => parseToolArguments('{broken'), /valid JSON/);
	});
});
