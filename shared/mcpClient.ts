/* eslint-disable @n8n/community-nodes/require-node-api-error -- This transport-agnostic client has no n8n node context; the node boundary converts its typed errors. */

import packageMetadata from '../package.json';

const MCP_PROTOCOL_VERSION = '2025-11-25';
const CLIENT_INFO = { name: packageMetadata.name, version: packageMetadata.version } as const;
const MAX_ARGUMENT_JSON_CHARACTERS = 1_000_000;
const MAX_ARGUMENT_DEPTH = 50;
const MAX_ARGUMENT_VALUES = 10_000;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 5_000;
const MAX_TOOL_LIST_CHARACTERS = 20_000_000;
const MAX_TOOL_LIST_DURATION_MS = 300_000;
const MAX_SAFE_ERROR_CHARACTERS = 2_000;
const MAX_RESPONSE_BODY_CHARACTERS = 10_000_000;

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
	body?: string;
	headers: Record<string, string>;
	method: 'DELETE' | 'POST';
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
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface McpContent {
	type: string;
	text?: string;
	[key: string]: unknown;
}

export interface McpCallToolResult {
	content: McpContent[];
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
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

export function buildMcpUrl(
	serverUrl: string,
	allowInsecureHttp = false,
	allowPrivateNetwork = false,
): string {
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
	if (
		[...url.searchParams.keys()].some((key) =>
			/^(?:token|api[_-]?key|access_token|id_token|refresh_token)$/i.test(key),
		)
	) {
		throw new Error('Server URL must not contain token or API key query parameters');
	}
	if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHostname(url.hostname)) {
		throw new Error(
			'Server URL must use HTTPS unless insecure HTTP is explicitly enabled for a trusted server',
		);
	}
	if (
		!allowPrivateNetwork &&
		!isLoopbackHostname(url.hostname) &&
		isPrivateNetworkAddress(url.hostname)
	) {
		throw new Error(
			'Server URL must not target a private network unless private network access is explicitly enabled',
		);
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
	validateToolArguments(parsedValue);
	return { ...parsedValue };
}

export function redactSensitiveQueryValues(message: string): string {
	return message.replace(
		/([?&](?:token|api[_-]?key|access_token|id_token|refresh_token)=)[^&\s]+/gi,
		'$1***',
	);
}

export function toSafeErrorMessage(message: string, secrets: string[] = []): string {
	let safeMessage = redactSensitiveQueryValues(message);
	for (const secret of secrets) {
		if (secret) {
			safeMessage = safeMessage.split(secret).join('***');
		}
	}
	if (safeMessage.length > MAX_SAFE_ERROR_CHARACTERS) {
		return `${safeMessage.slice(0, MAX_SAFE_ERROR_CHARACTERS)}...`;
	}
	return safeMessage;
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

		try {
			const { result } = await this.sendRequest<McpInitializeResult>('initialize', {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			});
			const validatedResult = validateInitializeResult(result);
			this.protocolVersion = validatedResult.protocolVersion;
			await this.sendNotification('notifications/initialized');
			this.initializationResult = validatedResult;
			return validatedResult;
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	async listTools(): Promise<McpTool[]> {
		await this.initialize();
		const tools: McpTool[] = [];
		const startedAt = Date.now();
		let toolCharacters = 0;
		let cursor: string | undefined;
		let pageCount = 0;
		const seenCursors = new Set<string>();

		do {
			if (Date.now() - startedAt > MAX_TOOL_LIST_DURATION_MS) {
				throw new McpProtocolError(
					`MCP tools/list exceeded ${MAX_TOOL_LIST_DURATION_MS} milliseconds`,
				);
			}
			pageCount += 1;
			if (pageCount > MAX_TOOL_PAGES) {
				throw new McpProtocolError(`MCP tools/list exceeded ${MAX_TOOL_PAGES} pages`);
			}
			const params = cursor !== undefined ? { cursor } : {};
			const { result } = await this.sendRequest<unknown>(
				'tools/list',
				params,
			);
			if (!isRecord(result) || !Array.isArray(result.tools)) {
				throw new McpProtocolError('MCP tools/list response does not contain a tools array');
			}
			const pageTools = result.tools.map(validateTool);
			toolCharacters += JSON.stringify(pageTools).length;
			if (toolCharacters > MAX_TOOL_LIST_CHARACTERS) {
				throw new McpProtocolError(
					`MCP tools/list exceeded ${MAX_TOOL_LIST_CHARACTERS} schema characters`,
				);
			}
			if (tools.length + pageTools.length > MAX_TOOLS) {
				throw new McpProtocolError(`MCP tools/list exceeded ${MAX_TOOLS} tools`);
			}
			tools.push(...pageTools);

			if (result.nextCursor !== undefined && typeof result.nextCursor !== 'string') {
				throw new McpProtocolError('MCP tools/list nextCursor must be a string');
			}
			cursor = result.nextCursor;
			if (cursor !== undefined && seenCursors.has(cursor)) {
				throw new McpProtocolError('MCP tools/list returned a repeated pagination cursor');
			}
			if (cursor !== undefined) {
				seenCursors.add(cursor);
			}
		} while (cursor !== undefined);

		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpCallToolResult> {
		await this.initialize();
		const { result } = await this.sendRequest<unknown>('tools/call', {
			name,
			arguments: args,
		});
		const validatedResult = validateCallToolResult(result);

		if (validatedResult.isError) {
			const message =
				validatedResult.content
					.filter((content) => content.type === 'text' && typeof content.text === 'string')
					.map((content) => content.text)
					.join('\n') || `MCP tool ${name} returned an error`;
			throw new McpProtocolError(message, -32000, validatedResult);
		}

		return validatedResult;
	}

	async close(): Promise<void> {
		if (!this.sessionId) {
			this.resetSession();
			return;
		}

		try {
			await this.requester({ method: 'DELETE', headers: this.createHeaders() });
		} catch {
			// Session cleanup is best-effort and must not replace a successful tool result.
		} finally {
			this.resetSession();
		}
	}

	private async sendRequest<T>(
		method: string,
		params: Record<string, unknown>,
		allowSessionRecovery = true,
	): Promise<{ response: McpHttpResponse; result: T }> {
		const id = this.nextRequestId++;
		const response = await this.performRequest({ jsonrpc: '2.0', id, method, params });
		if (method === 'initialize') {
			this.sessionId = readHeader(response.headers, 'mcp-session-id');
		}

		if (
			response.statusCode === 404 &&
			this.sessionId &&
			method !== 'initialize' &&
			allowSessionRecovery
		) {
			this.resetSession();
			await this.initialize();
			return await this.sendRequest<T>(method, params, false);
		}

		let message: JsonRpcResponse;
		try {
			message = parseResponse(response.body, id);
		} catch (error) {
			if (response.statusCode >= 400) {
				throw new McpProtocolError(
					`MCP server returned HTTP ${response.statusCode}`,
					undefined,
					undefined,
					response.statusCode,
				);
			}
			throw error;
		}

		if (message.error) {
			throw new McpProtocolError(
				message.error.message,
				message.error.code,
				message.error.data,
				response.statusCode,
			);
		}
		if (response.statusCode >= 400) {
			throw new McpProtocolError(
				`MCP server returned HTTP ${response.statusCode}`,
				undefined,
				message,
				response.statusCode,
			);
		}
		if (message.result === undefined) {
			throw new McpProtocolError('MCP response does not contain a result', undefined, message);
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

	private resetSession(): void {
		this.sessionId = undefined;
		this.protocolVersion = undefined;
		this.initializationResult = undefined;
	}
}

function validateInitializeResult(value: unknown): McpInitializeResult {
	if (!isRecord(value)) {
		throw new McpProtocolError('MCP initialize response must be an object');
	}
	if (value.protocolVersion !== MCP_PROTOCOL_VERSION) {
		throw new McpProtocolError(
			`MCP server selected unsupported protocol version ${String(value.protocolVersion)}`,
		);
	}
	if (!isRecord(value.capabilities) || !isRecord(value.capabilities.tools)) {
		throw new McpProtocolError('MCP server does not advertise the tools capability');
	}
	if (
		!isRecord(value.serverInfo) ||
		typeof value.serverInfo.name !== 'string' ||
		value.serverInfo.name === '' ||
		typeof value.serverInfo.version !== 'string' ||
		value.serverInfo.version === ''
	) {
		throw new McpProtocolError('MCP initialize response contains invalid serverInfo');
	}
	return value as unknown as McpInitializeResult;
}

function validateTool(value: unknown): McpTool {
	if (!isRecord(value) || typeof value.name !== 'string' || value.name.trim() === '') {
		throw new McpProtocolError('MCP tools/list returned a tool without a valid name');
	}
	if (value.description !== undefined && typeof value.description !== 'string') {
		throw new McpProtocolError(`MCP tool ${value.name} has an invalid description`);
	}
	if (!isRecord(value.inputSchema)) {
		throw new McpProtocolError(`MCP tool ${value.name} has an invalid inputSchema`);
	}
	if (value.outputSchema !== undefined && !isRecord(value.outputSchema)) {
		throw new McpProtocolError(`MCP tool ${value.name} has an invalid outputSchema`);
	}
	return value as McpTool;
}

function validateCallToolResult(value: unknown): McpCallToolResult {
	if (!isRecord(value)) {
		throw new McpProtocolError('MCP tools/call response must be an object');
	}
	if (value.isError !== undefined && typeof value.isError !== 'boolean') {
		throw new McpProtocolError('MCP tools/call isError must be a boolean');
	}
	if (
		!Array.isArray(value.content) ||
		value.content.some(
			(content) =>
				!isRecord(content) || typeof content.type !== 'string' || content.type.trim() === '',
		)
	) {
		throw new McpProtocolError('MCP tools/call content must be an array of content objects');
	}
	if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) {
		throw new McpProtocolError('MCP tools/call structuredContent must be an object');
	}
	return value as McpCallToolResult;
}

function validateToolArguments(value: Record<string, unknown>): void {
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error('Tool arguments must contain JSON-serializable values');
	}
	if (serialized.length > MAX_ARGUMENT_JSON_CHARACTERS) {
		throw new Error(`Tool arguments must not exceed ${MAX_ARGUMENT_JSON_CHARACTERS} characters`);
	}

	const pending: Array<{ depth: number; value: unknown }> = [{ depth: 0, value }];
	let valueCount = 0;
	while (pending.length > 0) {
		const entry = pending.pop();
		if (!entry) break;
		valueCount += 1;
		if (valueCount > MAX_ARGUMENT_VALUES) {
			throw new Error(`Tool arguments must not contain more than ${MAX_ARGUMENT_VALUES} values`);
		}
		if (entry.depth > MAX_ARGUMENT_DEPTH) {
			throw new Error(`Tool arguments must not exceed ${MAX_ARGUMENT_DEPTH} levels of nesting`);
		}
		if (Array.isArray(entry.value)) {
			for (const child of entry.value) pending.push({ depth: entry.depth + 1, value: child });
		} else if (isRecord(entry.value)) {
			for (const child of Object.values(entry.value)) {
				pending.push({ depth: entry.depth + 1, value: child });
			}
		}
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
	assertNoInvalidJsonRpcError(body);
	if (typeof body !== 'string' || body.trim() === '') {
		throw new McpProtocolError('MCP server returned an empty response');
	}
	if (body.length > MAX_RESPONSE_BODY_CHARACTERS) {
		throw new McpProtocolError(
			`MCP server response exceeds ${MAX_RESPONSE_BODY_CHARACTERS} characters`,
		);
	}

	const trimmedBody = body.trim();
	if (trimmedBody.startsWith('{')) {
		try {
			const parsed = JSON.parse(trimmedBody) as unknown;
			if (isJsonRpcResponse(parsed)) {
				return [parsed];
			}
			assertNoInvalidJsonRpcError(parsed);
		} catch (error) {
			if (error instanceof McpProtocolError) {
				throw error;
			}
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
		} catch (error) {
			if (error instanceof McpProtocolError) {
				throw error;
			}
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
		(typeof value.id === 'number' || typeof value.id === 'string') &&
		!('method' in value) &&
		(('result' in value) !== ('error' in value)) &&
		(!('error' in value) || isJsonRpcError(value.error))
	);
}

function assertNoInvalidJsonRpcError(value: unknown): void {
	if (
		isRecord(value) &&
		value.jsonrpc === '2.0' &&
		(typeof value.id === 'number' || typeof value.id === 'string') &&
		'error' in value &&
		!isJsonRpcError(value.error)
	) {
		throw new McpProtocolError('MCP server returned an invalid JSON-RPC error object');
	}
}

function isJsonRpcError(value: unknown): value is JsonRpcError {
	return (
		isRecord(value) &&
		typeof value.code === 'number' &&
		typeof value.message === 'string'
	);
}

function isLoopbackHostname(hostname: string): boolean {
	return (
		hostname.toLowerCase() === 'localhost' ||
		hostname === '[::1]' ||
		/^127(?:\.\d{1,3}){3}$/.test(hostname)
	);
}

function isPrivateNetworkAddress(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	const ipv4Parts = normalized.split('.').map(Number);
	if (
		ipv4Parts.length === 4 &&
		ipv4Parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
	) {
		const [first, second] = ipv4Parts;
		return (
			first === 0 ||
			first === 10 ||
			(first === 100 && second >= 64 && second <= 127) ||
			(first === 169 && second === 254) ||
			(first === 172 && second >= 16 && second <= 31) ||
			(first === 192 && second === 168) ||
			(first === 198 && (second === 18 || second === 19)) ||
			first >= 224
		);
	}
	return normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized);
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
