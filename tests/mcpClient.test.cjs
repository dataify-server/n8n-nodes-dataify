const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
	DataifyMcpClient,
	McpProtocolError,
	buildMcpUrl,
	parseToolArguments,
	redactSensitiveQueryValues,
	toSafeErrorMessage,
} = require('../dist/shared/mcpClient.js');

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

	it('reuses a completed initialization handshake', async () => {
		let requestCount = 0;
		const responses = [
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', headers: {}, statusCode: 202 },
		];
		const client = new DataifyMcpClient(async () => {
			requestCount += 1;
			return responses.shift();
		});

		const first = await client.initialize();
		const second = await client.initialize();

		assert.equal(first, second);
		assert.equal(requestCount, 2);
	});

	it('terminates and clears a stateful session', async () => {
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
				{ 'mcp-session-id': 'session-close' },
			),
			{ body: '', headers: {}, statusCode: 202 },
			{ body: '', headers: {}, statusCode: 200 },
		];
		const client = new DataifyMcpClient(async (request) => {
			requests.push(request);
			return responses.shift();
		});

		await client.initialize();
		await client.close();
		await client.close();

		assert.equal(requests.length, 3);
		assert.equal(requests[2].method, 'DELETE');
		assert.equal(requests[2].headers['Mcp-Session-Id'], 'session-close');
		assert.equal(requests[2].body, undefined);
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

	it('rejects malformed tools/list results', async () => {
		const responses = [
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', headers: {}, statusCode: 202 },
			jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: null } }),
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		await assert.rejects(client.listTools(), /does not contain a tools array/);
	});

	it('redacts token values from transport failures', async () => {
		const client = new DataifyMcpClient(async () => {
			throw new Error('request failed: https://example.com/mcp?token=secret&tools=free');
		});

		await assert.rejects(
			client.initialize(),
			(error) => error instanceof McpProtocolError && !error.message.includes('secret'),
		);
	});

	it('reinitializes once when the server expires a stateful session', async () => {
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
				{ 'mcp-session-id': 'expired-session' },
			),
			{ body: '', statusCode: 202 },
			{ body: 'session not found', statusCode: 404 },
			jsonResponse(
				{
					jsonrpc: '2.0',
					id: 3,
					result: {
						protocolVersion: '2025-11-25',
						capabilities: { tools: {} },
						serverInfo: { name: 'dataify', version: '1.0.0' },
					},
				},
				{ 'mcp-session-id': 'replacement-session' },
			),
			{ body: '', statusCode: 202 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 4,
				result: { tools: [{ name: 'task_status' }] },
			}),
		];
		const client = new DataifyMcpClient(async (request) => {
			requests.push(request);
			return responses.shift();
		});

		const tools = await client.listTools();

		assert.deepEqual(tools.map((tool) => tool.name), ['task_status']);
		assert.equal(requests[2].headers['Mcp-Session-Id'], 'expired-session');
		assert.equal(requests[3].headers['Mcp-Session-Id'], undefined);
		assert.equal(requests[5].headers['Mcp-Session-Id'], 'replacement-session');
	});

	it('does not cache initialization before the initialized notification succeeds', async () => {
		const responses = [
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', statusCode: 500 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 2,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', statusCode: 202 },
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		await assert.rejects(client.initialize(), /rejected notifications\/initialized/);
		const result = await client.initialize();

		assert.equal(result.serverInfo.name, 'dataify');
	});

	it('rejects unsupported protocol versions and missing tool capabilities', async () => {
		const incompatible = new DataifyMcpClient(async () =>
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
		);
		const withoutTools = new DataifyMcpClient(async () =>
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
		);

		await assert.rejects(incompatible.initialize(), /unsupported protocol version/);
		await assert.rejects(withoutTools.initialize(), /tools capability/);
	});

	it('rejects repeated tools pagination cursors', async () => {
		const responses = [
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', statusCode: 202 },
			jsonResponse({ jsonrpc: '2.0', id: 2, result: { tools: [], nextCursor: 'same' } }),
			jsonResponse({ jsonrpc: '2.0', id: 3, result: { tools: [], nextCursor: 'same' } }),
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		await assert.rejects(client.listTools(), /repeated pagination cursor/);
	});

	it('ignores JSON-RPC server requests while matching an SSE response', async () => {
		const responses = [
			jsonResponse({
				jsonrpc: '2.0',
				id: 1,
				result: {
					protocolVersion: '2025-11-25',
					capabilities: { tools: {} },
					serverInfo: { name: 'dataify', version: '1.0.0' },
				},
			}),
			{ body: '', statusCode: 202 },
			{
				body: [
					'data: {"jsonrpc":"2.0","id":2,"method":"roots/list","params":{}}',
					'',
					'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
					'',
				].join('\n'),
				statusCode: 200,
			},
		];
		const client = new DataifyMcpClient(async () => responses.shift());

		assert.deepEqual(await client.listTools(), []);
	});
});

describe('Dataify MCP helpers', () => {
	it('normalizes server URLs without duplicating the MCP path', () => {
		assert.equal(buildMcpUrl('http://localhost:7780/'), 'http://localhost:7780/mcp');
		assert.equal(buildMcpUrl('https://api.example.com/mcp'), 'https://api.example.com/mcp');
	});

	it('rejects unsafe or malformed server URLs', () => {
		assert.throws(() => buildMcpUrl('not-a-url'), /valid absolute URL/);
		assert.throws(() => buildMcpUrl('ftp://example.com'), /HTTP or HTTPS/);
		assert.throws(() => buildMcpUrl('https://user:pass@example.com'), /embedded credentials/);
		assert.throws(() => buildMcpUrl('https://example.com?token=secret'), /query parameters/);
		assert.throws(() => buildMcpUrl('http://api.example.com'), /must use HTTPS/);
		assert.equal(buildMcpUrl('http://api.example.com', true), 'http://api.example.com/mcp');
	});

	it('parses object and JSON string tool arguments', () => {
		assert.deepEqual(parseToolArguments({ q: 'n8n' }), { q: 'n8n' });
		assert.deepEqual(parseToolArguments('{"q":"n8n"}'), { q: 'n8n' });
		assert.deepEqual(parseToolArguments(''), {});
		assert.throws(() => parseToolArguments('["not-an-object"]'), /JSON object/);
		assert.throws(() => parseToolArguments('{broken'), /valid JSON/);
		let deeplyNested = {};
		for (let depth = 0; depth < 51; depth++) deeplyNested = { child: deeplyNested };
		assert.throws(() => parseToolArguments(deeplyNested), /levels of nesting/);
	});

	it('redacts API token and key query parameters', () => {
		assert.equal(
			redactSensitiveQueryValues(
				'https://example.com/mcp?token=secret&api_key=also-secret&tools=free',
			),
			'https://example.com/mcp?token=***&api_key=***&tools=free',
		);
	});

	it('redacts explicit secrets and safely handles empty secret values', () => {
		assert.equal(toSafeErrorMessage('token secret-token', ['secret-token']), 'token ***');
		assert.equal(toSafeErrorMessage('ordinary error', ['']), 'ordinary error');
	});
});
