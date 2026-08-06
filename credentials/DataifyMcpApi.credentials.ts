import type {
	IAuthenticate,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DataifyMcpApi implements ICredentialType {
	name = 'dataifyMcpApi';
	displayName = 'Dataify MCP API';
	icon = {
		light: 'file:../nodes/DataifyMcp/dataify.svg',
		dark: 'file:../nodes/DataifyMcp/dataify.dark.svg',
	} as const;
	documentationUrl = 'https://dashboard.dataify.com';
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
			displayName: 'Allow Insecure HTTP',
			name: 'allowInsecureHttp',
			type: 'boolean',
			default: false,
			description:
				'Whether to allow unencrypted HTTP for a trusted non-local server. HTTPS is strongly recommended.',
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
}
