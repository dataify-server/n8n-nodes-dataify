import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DataifyMcpApi implements ICredentialType {
	name = 'dataifyMcpApi';
	displayName = 'Dataify MCP API';
	documentationUrl = 'https://dataify.com';
	supportedNodes = ['dataifyMcp'];
	restrictToSupportedNodes = true as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'http://localhost:7780',
			placeholder: 'https://mcp.example.com',
			description: 'Base URL of the Dataify MCP server; /mcp is added automatically',
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Allowed Tools',
			name: 'allowedTools',
			type: 'string',
			default: '',
			placeholder: 'google_search,task_status',
			description:
				'Optional comma-separated tool or category codes to pass as the MCP tools query parameter',
		},
	];

	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		const allowedTools = String(credentials.allowedTools ?? '').trim();
		return {
			...requestOptions,
			qs: {
				...requestOptions.qs,
				token: String(credentials.apiToken),
				...(allowedTools ? { tools: allowedTools } : {}),
			},
		};
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\\/$/, "")}}',
			url: '/mcp',
			method: 'POST',
			headers: {
				Accept: 'application/json, text/event-stream',
				'Content-Type': 'application/json',
			},
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'n8n-nodes-dataify', version: '0.1.0' },
				},
			},
			json: true,
		},
	};
}
