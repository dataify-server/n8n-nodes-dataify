import type { IAuthenticate, ICredentialType, INodeProperties } from 'n8n-workflow';

export class DataifyMcpApi implements ICredentialType {
	name = 'dataifyMcpApi';
	displayName = 'Dataify MCP API';
	icon = {
		light: 'file:../nodes/DataifyMcp/dataify.svg',
		dark: 'file:../nodes/DataifyMcp/dataify.dark.svg',
	} as const;
	documentationUrl = 'https://doc.dataify.com/9142554m0';
	supportedNodes = ['dataifyMcp'];
	restrictToSupportedNodes = true as const;

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: 'https://mcp.dataify.com',
			placeholder: 'http://localhost:7780',
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
			displayName: 'Allow Private IP Address',
			name: 'allowPrivateNetwork',
			type: 'boolean',
			default: false,
			description:
				'Whether to allow a custom server URL containing a private-network IP address. Hostname resolution remains subject to the n8n host network policy.',
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
			headers: {
				...requestOptions.headers,
				Authorization: `Bearer ${String(credentials.apiToken)}`,
			},
			qs: {
				...requestOptions.qs,
				...(allowedTools ? { tools: allowedTools } : {}),
			},
		};
	};
}
