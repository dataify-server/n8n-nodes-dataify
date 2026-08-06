# n8n-nodes-dataify

This n8n community node connects workflows to the Dataify MCP API. It discovers the tools available to the configured token at runtime, so newly added Dataify tools can be used without updating the node package.

## Installation

Install `n8n-nodes-dataify` from the Community Nodes settings in a self-hosted n8n instance, or follow the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

For local development:

```bash
npm install
npm run dev
```

## Operations

- **Tool: Call** - Select or enter an MCP tool name and call it with a JSON arguments object.
- **Server: List Tools** - Return all tools visible to the configured API token, optionally including their JSON schemas.

## Credentials

Create a **Dataify MCP API** credential with:

- **Server URL** - The Dataify MCP server base URL. The node adds `/mcp` automatically.
- **API Token** - Obtain one from the [Dataify dashboard](https://dashboard.dataify.com). It is sent as the required `token` query parameter and stored encrypted by n8n.
- **Allow Insecure HTTP** - Disabled by default for non-local servers. Enable only for a trusted private deployment that cannot use HTTPS.
- **Allowed Tools** - Optional comma-separated tool or category codes sent as the `tools` query parameter.

The default local server URL is `http://localhost:7780`.
Remote servers must use HTTPS by default. Because the Dataify API contract places the token in the query string, configure reverse proxies and access logs to redact query parameters.

## Usage

Choose a tool from the dynamic list or enter its exact MCP name. The list identifies required input fields when the server schema provides them. The **Arguments** field must be a JSON object matching that tool's input schema. Keep **Simplify Output** enabled to return `structuredContent` when the tool provides it, or disable it to receive the full MCP tool result.

The node supports the Dataify server's Streamable HTTP transport and accepts its buffered JSON and Server-Sent Events responses. Each input item is executed independently and supports n8n's **Continue On Fail** setting.

## Compatibility

Built with the official `@n8n/node-cli` toolchain and Node.js 22. The package uses the MCP protocol version supported by `dataify_mcp_api` (`2025-11-25`).

## Resources

- [Dataify](https://dataify.com)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Version history

- **0.1.0** - Initial release with dynamic tool discovery and tool calls.
