const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { DataifyMcpApi } = require('../dist/credentials/DataifyMcpApi.credentials.js');
const { DataifyMcp } = require('../dist/nodes/DataifyMcp/DataifyMcp.node.js');

function jsonResponse(body, headers = {}, statusCode = 200) {
	return { body: JSON.stringify(body), headers, statusCode };
}

function initializeResponse(sessionId = 'session-123') {
	return jsonResponse(
		{
			jsonrpc: '2.0',
			id: 1,
			result: {
				protocolVersion: '2025-11-25',
				capabilities: { tools: {} },
				serverInfo: { name: 'dataify', version: '1.0.0' },
			},
		},
		{ 'mcp-session-id': sessionId },
	);
}

describe('Dataify MCP credentials', () => {
	it('adds token and optional tool filters without changing the request URL', async () => {
		const credential = new DataifyMcpApi();

		const options = await credential.authenticate(
			{ apiToken: 'secret-token', allowedTools: 'google_search,task_status' },
			{ url: 'https://mcp.example.com/mcp', method: 'POST' },
		);

		assert.equal(options.url, 'https://mcp.example.com/mcp');
		assert.deepEqual(options.qs, {
			token: 'secret-token',
			tools: 'google_search,task_status',
		});
	});

	it('tests the token with the read-only query_user_info tool and closes the session', async () => {
		const node = new DataifyMcp();
		const requests = [];
		const responses = [
			initializeResponse('credential-session'),
			{ body: '', headers: {}, statusCode: 202 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 2,
				result: { tools: [{ name: 'query_user_info' }] },
			}),
			jsonResponse({
				jsonrpc: '2.0',
				id: 3,
				result: { structuredContent: { username: 'test-user' } },
			}),
			{ body: '', headers: {}, statusCode: 200 },
		];
		const context = {
			helpers: {
				request: async (options) => {
					requests.push(options);
					return responses.shift();
				},
			},
		};

		const result = await node.methods.credentialTest.testDataifyMcp.call(context, {
			data: {
				serverUrl: 'http://localhost:7780/mcp',
				apiToken: 'secret-token',
				allowedTools: 'google_search',
			},
		});

		assert.equal(result.status, 'OK');
		const testUrl = new URL(requests[0].uri);
		assert.equal(testUrl.pathname, '/mcp');
		assert.equal(testUrl.searchParams.get('token'), 'secret-token');
		assert.equal(testUrl.searchParams.get('tools'), 'google_search,query_user_info');
		assert.deepEqual(JSON.parse(requests[3].body).params, {
			name: 'query_user_info',
			arguments: {},
		});
		assert.equal(requests[4].method, 'DELETE');
	});
});

describe('Dataify MCP node execution', () => {
	it('returns structured content with item pairing and closes the MCP session', async () => {
		const node = new DataifyMcp();
		const requests = [];
		const responses = [
			initializeResponse('execution-session'),
			{ body: '', headers: {}, statusCode: 202 },
			jsonResponse({
				jsonrpc: '2.0',
				id: 2,
				result: {
					content: [{ type: 'text', text: 'ok' }],
					structuredContent: { taskId: 'task-123' },
				},
			}),
			{ body: '', headers: {}, statusCode: 200 },
		];
		const context = createExecuteContext({
			requests,
			responses,
			parameters: {
				resource: 'tool',
				operation: 'call',
				toolName: 'google_search',
				arguments: '{"q":"n8n"}',
				simplifyOutput: true,
			},
		});

		const result = await node.execute.call(context);

		assert.deepEqual(result, [[{ json: { taskId: 'task-123' }, pairedItem: { item: 0 } }]]);
		assert.equal(requests[3].method, 'DELETE');
		assert.equal(requests[3].headers['Mcp-Session-Id'], 'execution-session');
	});

	it('redacts credential values in Continue On Fail output', async () => {
		const node = new DataifyMcp();
		const context = createExecuteContext({
			continueOnFail: true,
			parameters: {
				resource: 'tool',
				operation: 'call',
				toolName: 'google_search',
				arguments: '{}',
				simplifyOutput: true,
			},
			requestError: new Error(
				'request failed: http://localhost:7780/mcp?token=secret-token&tools=free',
			),
		});

		const result = await node.execute.call(context);

		assert.equal(result[0][0].json.error.includes('secret-token'), false);
		assert.match(result[0][0].json.error, /token=\*\*\*/);
	});
});

function createExecuteContext({
	continueOnFail = false,
	parameters,
	requestError,
	requests = [],
	responses = [],
}) {
	return {
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({
			serverUrl: 'http://localhost:7780',
			apiToken: 'secret-token',
			allowInsecureHttp: false,
		}),
		getInputData: () => [{ json: {} }],
		getNode: () => ({
			name: 'Dataify MCP',
			type: 'dataifyMcp',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		getNodeParameter: (name) => parameters[name],
		helpers: {
			httpRequestWithAuthentication: async (_credentialType, options) => {
				requests.push(options);
				if (requestError) throw requestError;
				return responses.shift();
			},
		},
	};
}
