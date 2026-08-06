const MCP_PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = { name: 'n8n-nodes-dataify', version: '0.1.0' } as const;

type JsonRpcId = number | string;

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: JsonRpcId;
	result?: unknown;
	error?: JsonRpcError;
}

export interface McpHttpRequest {
	body: string;
	headers: Record<string, string>;
	method: 'POST';
}

export interface McpHttpResponse {
	body?: unknown;
	headers?: Record<string, unknown>;
	statusCode: number;
}

export type McpHttpRequester = (request: McpHttpRequest) => Promise<McpHttpResponse>;

export interface McpServerInfo {
	name: string;
	version: string;
}

export interface McpInitializeResult {
	protocolVersion: string;
	capabilities: Record<string, unknown>;
	serverInfo: McpServerInfo;
}

export interface McpTool {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface McpContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content?: McpContent[];
	isError?: boolean;
	structuredContent?: unknown;
	[key: string]: unknown;
}

export class McpProtocolError extends Error {
	constructor(
		message: string,
		public readonly code?: number,
		public readonly data?: unknown,
		public readonly statusCode?: number,
	) {
		super(message);
		this.name = 'McpProtocolError';
	}
}

export function buildMcpUrl(serverUrl: string): string {
	let url: URL;
	try {
		url = new URL(serverUrl.trim());
	} catch {
		throw new Error('Server URL must be a valid absolute URL');
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Server URL must use HTTP or HTTPS');
	}
	if (url.username || url.password) {
		throw new Error('Server URL must not contain embedded credentials');
	}

	url.pathname = url.pathname.replace(/\/+$/, '');
	if (!url.pathname.endsWith('/mcp')) {
		url.pathname = `${url.pathname}/mcp`.replace(/^\/\//, '/');
	}
	return url.toString();
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
	let parsedValue = value;
	if (typeof value === 'string') {
		if (value.trim() === '') {
			return {};
		}
		try {
			parsedValue = JSON.parse(value) as unknown;
		} catch {
			throw new Error('Tool arguments must be valid JSON');
		}
	}

	if (!isRecord(parsedValue)) {
		throw new Error('Tool arguments must be a JSON object');
	}
	return { ...parsedValue };
}

export function redactSensitiveQueryValues(message: string): string {
	return message.replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, '$1***');
}

export class DataifyMcpClient {
	private nextRequestId = 1;
	private protocolVersion?: string;
	private sessionId?: string;
	private initializationResult?: McpInitializeResult;

	constructor(private readonly requester: McpHttpRequester) {}

	async initialize(): Promise<McpInitializeResult> {
		if (this.initializationResult) {
			return this.initializationResult;
		}

		const { response, result } = await this.sendRequest<McpInitializeResult>('initialize', {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: CLIENT_INFO,
		});

		this.protocolVersion = result.protocolVersion;
		this.sessionId = readHeader(response.headers, 'mcp-session-id');
		this.initializationResult = result;

		await this.sendNotification('notifications/initialized');
		return result;
	}

	async listTools(): Promise<McpTool[]> {
		await this.initialize();
		const tools: McpTool[] = [];
		let cursor: string | undefined;

		do {
			const params = cursor ? { cursor } : {};
			const { result } = await this.sendRequest<{ tools: McpTool[]; nextCursor?: string }>(
				'tools/list',
				params,
			);
			if (!Array.isArray(result.tools)) {
				throw new McpProtocolError('MCP tools/list response does not contain a tools array');
			}
			tools.push(...result.tools);
			cursor = result.nextCursor;
		} while (cursor);

		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
		await this.initialize();
		const { result } = await this.sendRequest<McpCallToolResult>('tools/call', {
			name,
			arguments: args,
		});

		if (result.isError) {
			const message =
				result.content
					?.filter((content) => content.type === 'text' && typeof content.text === 'string')
					.map((content) => content.text)
					.join('\n') || `MCP tool ${name} returned an error`;
			throw new McpProtocolError(message, -32000, result);
		}

		return result;
	}

	private async sendRequest<T>(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ response: McpHttpResponse; result: T }> {
		const id = this.nextRequestId++;
		const response = await this.performRequest({ jsonrpc: '2.0', id, method, params });
		const message = parseResponse(response.body, id);

		if (message.error) {
			throw new McpProtocolError(
				message.error.message,
				message.error.code,
				message.error.data,
				response.statusCode,
			);
		}
		if (message.result === undefined) {
			throw new McpProtocolError('MCP response does not contain a result', undefined, message);
		}
		if (response.statusCode >= 400) {
			throw new McpProtocolError(
				`MCP server returned HTTP ${response.statusCode}`,
				undefined,
				message,
				response.statusCode,
			);
		}

		return { response, result: message.result as T };
	}

	private async sendNotification(method: string): Promise<void> {
		const response = await this.performRequest({ jsonrpc: '2.0', method });
		if (response.statusCode >= 400) {
			throw new McpProtocolError(
				`MCP server rejected ${method} with HTTP ${response.statusCode}`,
				undefined,
				response.body,
				response.statusCode,
			);
		}
	}

	private async performRequest(payload: Record<string, unknown>): Promise<McpHttpResponse> {
		try {
			return await this.requester({
				method: 'POST',
				headers: this.createHeaders(),
				body: JSON.stringify(payload),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new McpProtocolError(redactSensitiveQueryValues(message));
		}
	}

	private createHeaders(): Record<string, string> {
		return {
			Accept: 'application/json, text/event-stream',
			'Content-Type': 'application/json',
			...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
			...(this.protocolVersion ? { 'Mcp-Protocol-Version': this.protocolVersion } : {}),
		};
	}
}

function parseResponse(body: unknown, requestId: JsonRpcId): JsonRpcResponse {
	const messages = parseMessages(body);
	const message = messages.find((candidate) => candidate.id === requestId);
	if (!message) {
		throw new McpProtocolError(`MCP response does not contain JSON-RPC ID ${requestId}`);
	}
	return message;
}

function parseMessages(body: unknown): JsonRpcResponse[] {
	if (isJsonRpcResponse(body)) {
		return [body];
	}
	if (typeof body !== 'string' || body.trim() === '') {
		throw new McpProtocolError('MCP server returned an empty response');
	}

	const trimmedBody = body.trim();
	if (trimmedBody.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmedBody) as unknown;
			if (isJsonRpcResponse(parsed)) {
				return [parsed];
			}
		} catch (error) {
			throw new McpProtocolError(
				`MCP server returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const messages: JsonRpcResponse[] = [];
	let dataLines: string[] = [];
	const flushEvent = () => {
		if (dataLines.length === 0) {
			return;
		}
		const data = dataLines.join('\n');
		dataLines = [];
		if (data === '[DONE]') {
			return;
		}
		try {
			const parsed = JSON.parse(data) as unknown;
			if (isJsonRpcResponse(parsed)) {
				messages.push(parsed);
			}
		} catch {
			// Ignore non-JSON SSE events and continue looking for the matching response.
		}
	};

	for (const line of body.split(/\r?\n/)) {
		if (line === '') {
			flushEvent();
		} else if (line.startsWith('data:')) {
			dataLines.push(line.slice(5).trimStart());
		}
	}
	flushEvent();

	if (messages.length === 0) {
		throw new McpProtocolError('MCP server returned an unsupported response format');
	}
	return messages;
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
	return (
		isRecord(value) &&
		value.jsonrpc === '2.0' &&
		(typeof value.id === 'number' || typeof value.id === 'string')
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readHeader(headers: Record<string, unknown> | undefined, name: string): string | undefined {
	if (!headers) {
		return undefined;
	}
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	const value = entry?.[1];
	if (Array.isArray(value)) {
		return value.length > 0 ? String(value[0]) : undefined;
	}
	return value === undefined || value === null ? undefined : String(value);
}
