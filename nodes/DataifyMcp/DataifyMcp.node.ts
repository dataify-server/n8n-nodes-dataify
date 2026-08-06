import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	buildMcpUrl,
	DataifyMcpClient,
	type McpCallToolResult,
	type McpHttpResponse,
	McpProtocolError,
	type McpTool,
	parseToolArguments,
} from './mcpClient';

const CREDENTIAL_TYPE = 'dataifyMcpApi';

type DataifyFunctions = IExecuteFunctions | ILoadOptionsFunctions;

export class DataifyMcp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dataify MCP',
		name: 'dataifyMcp',
		icon: 'file:dataify.svg',
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'List and call tools exposed by the Dataify MCP API',
		defaults: { name: 'Dataify MCP' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIAL_TYPE, required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Tool', value: 'tool' },
					{ name: 'Server', value: 'server' },
				],
				default: 'tool',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['tool'] } },
				options: [
					{
						name: 'Call',
						value: 'call',
						description: 'Call a Dataify MCP tool',
						action: 'Call a tool',
					},
				],
				default: 'call',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['server'] } },
				options: [
					{
						name: 'List Tools',
						value: 'listTools',
						description: 'List tools visible to the configured token',
						action: 'List available tools',
					},
				],
				default: 'listTools',
			},
			{
				displayName: 'Tool',
				name: 'toolName',
				type: 'resourceLocator',
				required: true,
				default: { mode: 'list', value: '' },
				description: 'MCP tool to call',
				displayOptions: { show: { resource: ['tool'], operation: ['call'] } },
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: { searchListMethod: 'searchTools', searchable: true },
					},
					{
						displayName: 'By Name',
						name: 'name',
						type: 'string',
						placeholder: 'google_search',
					},
				],
			},
			{
				displayName: 'Arguments',
				name: 'arguments',
				type: 'json',
				required: true,
				default: '{}',
				description: 'JSON object matching the selected MCP tool input schema',
				displayOptions: { show: { resource: ['tool'], operation: ['call'] } },
			},
			{
				displayName: 'Simplify Output',
				name: 'simplifyOutput',
				type: 'boolean',
				default: true,
				description: 'Whether to return structured content instead of the full MCP result',
				displayOptions: { show: { resource: ['tool'], operation: ['call'] } },
			},
			{
				displayName: 'Include Schemas',
				name: 'includeSchemas',
				type: 'boolean',
				default: false,
				description: 'Whether to include input and output JSON schemas for every tool',
				displayOptions: { show: { resource: ['server'], operation: ['listTools'] } },
			},
		],
	};

	methods = {
		listSearch: {
			async searchTools(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const client = await createClient(this);
				const normalizedFilter = filter?.trim().toLowerCase() ?? '';
				const tools = await client.listTools();
				return {
					results: tools
						.filter((tool) => {
							if (!normalizedFilter) return true;
							return `${tool.name} ${tool.description ?? ''}`
								.toLowerCase()
								.includes(normalizedFilter);
						})
						.map((tool) => ({
							name: tool.name,
							value: tool.name,
							description: tool.description,
						})),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const client = await createClient(this);

				if (resource === 'tool' && operation === 'call') {
					const toolName = this.getNodeParameter('toolName', itemIndex, '', {
						extractValue: true,
					}) as string;
					if (!toolName.trim()) {
						throw new NodeOperationError(this.getNode(), 'Tool name is required', { itemIndex });
					}
					const args = parseToolArguments(this.getNodeParameter('arguments', itemIndex, '{}'));
					const result = await client.callTool(toolName, args);
					const simplifyOutput = this.getNodeParameter('simplifyOutput', itemIndex) as boolean;
					returnData.push({
						json: simplifyOutput ? simplifyToolResult(result) : (result as IDataObject),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (resource === 'server' && operation === 'listTools') {
					const includeSchemas = this.getNodeParameter('includeSchemas', itemIndex) as boolean;
					const tools = await client.listTools();
					for (const tool of tools) {
						returnData.push({
							json: formatTool(tool, includeSchemas),
							pairedItem: { item: itemIndex },
						});
					}
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					`Unsupported Dataify MCP operation: ${resource}.${operation}`,
					{ itemIndex },
				);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeOperationError || error instanceof NodeApiError) {
					throw error;
				}
				if (error instanceof McpProtocolError) {
					const apiError: JsonObject = {
						message: error.message,
						...(error.code !== undefined ? { code: error.code } : {}),
						...(error.statusCode !== undefined
							? { httpCode: String(error.statusCode) }
							: {}),
					};
					throw new NodeApiError(this.getNode(), apiError, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}

		return [returnData];
	}
}

async function createClient(context: DataifyFunctions): Promise<DataifyMcpClient> {
	const credentials = (await context.getCredentials(
		CREDENTIAL_TYPE,
	)) as ICredentialDataDecryptedObject;
	const url = buildMcpUrl(String(credentials.serverUrl));

	return new DataifyMcpClient(async (request) => {
		const requestOptions: IHttpRequestOptions = {
			url,
			method: request.method,
			headers: request.headers,
			body: request.body,
			encoding: 'text',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		};
		const response = await context.helpers.httpRequestWithAuthentication.call(
			context,
			CREDENTIAL_TYPE,
			requestOptions,
		);
		return response as McpHttpResponse;
	});
}

function simplifyToolResult(result: McpCallToolResult): IDataObject {
	if (isDataObject(result.structuredContent)) {
		return result.structuredContent as IDataObject;
	}
	if (result.structuredContent !== undefined) {
		return { structuredContent: result.structuredContent as IDataObject[keyof IDataObject] };
	}

	const text = result.content
		?.filter((content) => content.type === 'text' && typeof content.text === 'string')
		.map((content) => content.text)
		.join('\n');
	if (text) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (isDataObject(parsed)) {
				return parsed as IDataObject;
			}
		} catch {
			// Text content is allowed to be plain text rather than JSON.
		}
		return { text };
	}

	return { content: (result.content ?? []) as IDataObject[keyof IDataObject] };
}

function formatTool(tool: McpTool, includeSchemas: boolean): IDataObject {
	if (includeSchemas) {
		return tool as IDataObject;
	}
	const { inputSchema: _inputSchema, outputSchema: _outputSchema, ...summary } = tool;
	return summary as IDataObject;
}

function isDataObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
