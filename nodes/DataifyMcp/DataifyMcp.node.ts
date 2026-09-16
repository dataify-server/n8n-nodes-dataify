import type {
	ICredentialDataDecryptedObject,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IN8nHttpFullResponse,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeListSearchResult,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	ResourceMapperField,
	ResourceMapperFields,
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
	toSafeErrorMessage,
} from '../../shared/mcpClient';

const CREDENTIAL_TYPE = 'dataifyMcpApi';
const REQUEST_TIMEOUT_MS = 180_000;

type DataifyFunctions = IExecuteFunctions | ILoadOptionsFunctions;

export class DataifyMcp implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dataify MCP',
		name: 'dataifyMcp',
		icon: { light: 'file:dataify.svg', dark: 'file:dataify.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'List and call tools exposed by the Dataify MCP API',
		defaults: { name: 'Dataify MCP' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'dataifyMcpApi', required: true, testedBy: 'testDataifyMcp' }],
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
				displayName: 'Arguments Mode',
				name: 'argumentsMode',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['tool'], operation: ['call'] } },
				options: [
					{
						name: 'Form',
						value: 'form',
						description:
							'Fill in each parameter using a form generated from the selected tool schema',
					},
					{
						name: 'Raw JSON',
						value: 'json',
						description: 'Provide a raw JSON object; supports AI auto-fill',
					},
				],
				default: 'form',
			},
			{
				displayName: 'Arguments',
				name: 'argumentsForm',
				type: 'resourceMapper',
				default: { mappingMode: 'defineBelow', value: null },
				noDataExpression: true,
				typeOptions: {
					loadOptionsDependsOn: ['toolName.value'],
					resourceMapper: {
						resourceMapperMethod: 'getToolParameters',
						mode: 'add',
						fieldWords: { singular: 'parameter', plural: 'parameters' },
						addAllFields: true,
						supportAutoMap: false,
						hideNoDataError: true,
					},
				},
				displayOptions: {
					show: { resource: ['tool'], operation: ['call'], argumentsMode: ['form'] },
				},
			},
			{
				displayName: 'Arguments (JSON)',
				name: 'arguments',
				type: 'json',
				default: '{}',
				description: 'JSON object matching the selected MCP tool input schema',
				displayOptions: {
					show: { resource: ['tool'], operation: ['call'], argumentsMode: ['json'] },
				},
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
		credentialTest: {
			async testDataifyMcp(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
			): Promise<INodeCredentialTestResult> {
				const credentialData = credential.data ?? {};
				const token = String(credentialData.apiToken ?? '');
				let client: DataifyMcpClient | undefined;
				try {
					const url = new URL(
						buildMcpUrl(
							String(credentialData.serverUrl ?? ''),
							credentialData.allowInsecureHttp === true,
							credentialData.allowPrivateNetwork === true,
						),
					);
					const allowedTools = String(credentialData.allowedTools ?? '').trim();
					const credentialTestTools = new Set(
						allowedTools
							.split(',')
							.map((tool) => tool.trim())
							.filter(Boolean),
					);
					credentialTestTools.add('query_user_info');
					url.searchParams.set('tools', [...credentialTestTools].join(','));

					client = new DataifyMcpClient(async (request) => {
						// Credential test contexts currently expose only the legacy request helper.
						// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
						const response = (await this.helpers.request({
							uri: url.toString(),
							method: request.method,
							headers: {
								...request.headers,
								Authorization: `Bearer ${token}`,
							},
							...(request.body !== undefined ? { body: request.body } : {}),
							encoding: 'utf8',
							followAllRedirects: false,
							followRedirect: false,
							maxRedirects: 0,
							resolveWithFullResponse: true,
							sendCredentialsOnCrossOriginRedirect: false,
							simple: false,
							timeout: REQUEST_TIMEOUT_MS,
						})) as IN8nHttpFullResponse;
						return {
							body: response.body,
							headers: response.headers,
							statusCode: response.statusCode,
						};
					});

					const tools = await client.listTools();
					if (tools.length === 0) {
						return {
							status: 'Error',
							message:
								'Connected, but no tools are visible. Check the API token and allowed tools.',
						};
					}
					await client.callTool('query_user_info', {});
					return { status: 'OK', message: `Connected successfully (${tools.length} tools)` };
				} catch (error) {
					const rawMessage = error instanceof Error ? error.message : String(error);
					const redactedMessage = toSafeErrorMessage(rawMessage, [token]);
					return { status: 'Error', message: `Connection failed: ${redactedMessage}` };
				} finally {
					await client?.close();
				}
			},
		},
		listSearch: {
			async searchTools(
				this: ILoadOptionsFunctions,
				filter?: string,
			): Promise<INodeListSearchResult> {
				const token = await readApiTokenForRedaction(this);
				let client: DataifyMcpClient | undefined;
				try {
					client = await createClient(this);
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
								name: formatToolSearchLabel(tool),
								value: tool.name,
								description: formatToolSearchDescription(tool),
							})),
					};
				} catch (error) {
					const rawMessage = error instanceof Error ? error.message : String(error);
					const safeMessage = toSafeErrorMessage(rawMessage, [token]);
					throw new NodeOperationError(this.getNode(), safeMessage);
				} finally {
					await client?.close();
				}
			},
		},
		resourceMapping: {
			async getToolParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const toolNameParam = this.getNodeParameter('toolName', undefined) as
					| { value?: string }
					| string
					| undefined;
				const toolName =
					typeof toolNameParam === 'string' ? toolNameParam : String(toolNameParam?.value ?? '');
				if (!toolName?.trim()) {
					return { fields: [] };
				}

				let client: DataifyMcpClient | undefined;
				try {
					client = await createClient(this);
					const tools = await client.listTools();
					const tool = tools.find((candidate) => candidate.name === toolName);
					if (!tool?.inputSchema) {
						return { fields: [] };
					}
					return { fields: jsonSchemaToResourceMapperFields(tool.inputSchema) };
				} catch {
					return { fields: [] };
				} finally {
					await client?.close();
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let client: DataifyMcpClient | undefined;
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				client = await createClient(this);

				if (resource === 'tool' && operation === 'call') {
					const toolName = this.getNodeParameter('toolName', itemIndex, '', {
						extractValue: true,
					}) as string;
					if (!toolName.trim()) {
						throw new NodeOperationError(this.getNode(), 'Tool name is required', { itemIndex });
					}
					const args = readToolArguments(this, itemIndex);
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
				const safeMessage = toSafeErrorMessage(
					error instanceof Error ? error.message : String(error),
					[await readApiTokenForRedaction(this)],
				);
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: safeMessage },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof McpProtocolError) {
					const apiError: JsonObject = {
						message: safeMessage,
						...(error.code !== undefined ? { code: error.code } : {}),
						...(error.statusCode !== undefined ? { httpCode: String(error.statusCode) } : {}),
					};
					throw new NodeApiError(this.getNode(), apiError, { itemIndex });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			} finally {
				await client?.close();
			}
		}

		return [returnData];
	}
}

async function readApiTokenForRedaction(context: DataifyFunctions): Promise<string> {
	try {
		const credentials = (await context.getCredentials(
			CREDENTIAL_TYPE,
		)) as ICredentialDataDecryptedObject;
		return String(credentials.apiToken ?? '');
	} catch {
		return '';
	}
}

async function createClient(context: DataifyFunctions): Promise<DataifyMcpClient> {
	const credentials = (await context.getCredentials(
		CREDENTIAL_TYPE,
	)) as ICredentialDataDecryptedObject;
	const url = buildMcpUrl(
		String(credentials.serverUrl),
		credentials.allowInsecureHttp === true,
		credentials.allowPrivateNetwork === true,
	);
	const allowedDomain = new URL(url).hostname;

	return new DataifyMcpClient(async (request) => {
		const requestOptions: IHttpRequestOptions = {
			url,
			method: request.method,
			headers: request.headers,
			body: request.body,
			encoding: 'text',
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			allowedDomains: allowedDomain,
			maxRedirects: 0,
			sendCredentialsOnCrossOriginRedirect: false,
			timeout: REQUEST_TIMEOUT_MS,
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

	const text = result.content
		.filter((content) => content.type === 'text' && typeof content.text === 'string')
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

	return { content: result.content as IDataObject[keyof IDataObject] };
}

function formatTool(tool: McpTool, includeSchemas: boolean): IDataObject {
	if (includeSchemas) {
		return tool as IDataObject;
	}
	return Object.fromEntries(
		Object.entries(tool).filter(([key]) => key !== 'inputSchema' && key !== 'outputSchema'),
	) as IDataObject;
}

function formatToolSearchDescription(tool: McpTool): string | undefined {
	const required = tool.inputSchema?.required;
	const requiredNames = Array.isArray(required)
		? required.filter((name): name is string => typeof name === 'string')
		: [];
	const requiredText = requiredNames.length > 0 ? `Required: ${requiredNames.join(', ')}` : '';
	const description = [tool.description, requiredText].filter(Boolean).join(' | ');
	return description ? description.slice(0, 500) : undefined;
}

function isDataObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readToolArguments(context: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	const argumentsMode = context.getNodeParameter('argumentsMode', itemIndex, 'json') as string;
	if (argumentsMode === 'form') {
		const mapping = context.getNodeParameter('argumentsForm', itemIndex, {}) as {
			value?: unknown;
		};
		if (isDataObject(mapping?.value) && Object.keys(mapping.value).length > 0) {
			return parseToolArguments(mapping.value);
		}
	}
	return parseToolArguments(context.getNodeParameter('arguments', itemIndex, '{}'));
}

function jsonSchemaToResourceMapperFields(schema: Record<string, unknown>): ResourceMapperField[] {
	const properties = isDataObject(schema.properties) ? schema.properties : {};
	const requiredNames = new Set(
		Array.isArray(schema.required)
			? schema.required.filter((name): name is string => typeof name === 'string')
			: [],
	);

	const fields: ResourceMapperField[] = [];
	for (const [name, rawProperty] of Object.entries(properties)) {
		const property = isDataObject(rawProperty) ? rawProperty : {};
		const enumValues = Array.isArray(property.enum) ? property.enum : undefined;
		const description = typeof property.description === 'string' ? property.description.trim() : '';

		const field: ResourceMapperField = {
			id: name,
			displayName: description ? `${name} - ${truncateText(description, 120)}` : name,
			required: requiredNames.has(name),
			defaultMatch: false,
			canBeUsedToMatch: false,
			display: true,
			type: enumValues ? 'options' : mapJsonSchemaTypeToResourceMapperType(property.type),
		};

		if (enumValues) {
			field.options = enumValues.map((value) => ({
				name: String(value),
				value: value as string | number | boolean,
			}));
		}

		fields.push(field);
	}

	return fields;
}

function mapJsonSchemaTypeToResourceMapperType(type: unknown): ResourceMapperField['type'] {
	switch (type) {
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'object':
			return 'object';
		case 'array':
			return 'array';
		default:
			return 'string';
	}
}

function truncateText(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

function formatToolSearchLabel(tool: McpTool): string {
	const description = tool.description?.trim();
	if (!description) {
		return tool.name;
	}
	return `${tool.name} - ${truncateText(description, 90)}`;
}
