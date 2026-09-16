<<<<<<< HEAD
=======

>>>>>>> ce69236506a86f3e8e0e74d51dcd72538c339d9e
# n8n-nodes-dataify

This n8n community node connects workflows to the Dataify MCP API. It discovers the tools available to the configured token at runtime, so newly added Dataify tools can be used without updating the node package.

## Installation

Install `n8n-nodes-dataify` from the Community Nodes settings in a self-hosted n8n instance:

1. In n8n, go to **Settings → Community Nodes**.
2. Select **Install**, search for `n8n-nodes-dataify`, and install it.

For more details, see the [n8n community node installation guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Operations

- **Tool: Call** - Select or enter an MCP tool name and call it with a JSON arguments object.
- **Server: List Tools** - Return all tools visible to the configured API token, optionally including their JSON schemas.

## Credentials

Create a **Dataify MCP API** credential with:

- **Server URL** - The Dataify MCP server base URL. The node adds `/mcp` automatically.
- **API Token** - Obtain one from the [Dataify dashboard](https://dashboard.dataify.com). It is stored encrypted by n8n and sent in the `Authorization: Bearer` header.
- **Allow Insecure HTTP** - Disabled by default for non-local servers. Enable only for a trusted private deployment that cannot use HTTPS.
- **Allow Private IP Address** - Disabled by default. Enable only when a trusted self-hosted server URL contains a private-network IP address.
- **Allowed Tools** - Optional comma-separated tool or category codes sent as the `tools` query parameter.

The default server URL is `https://mcp.dataify.com`. Custom remote servers must use HTTPS by default, and API tokens are never added to the URL.

## Usage

Choose a tool from the dynamic list or enter its exact MCP name. The **Arguments** field must be a JSON object matching the input schema of that tool. Keep **Simplify Output** enabled to return `structuredContent` when the tool provides it, or disable it to receive the full MCP tool result.

The node supports the Streamable HTTP transport of the Dataify server and accepts its buffered JSON and Server-Sent Events responses. Each input item is executed independently and supports the **Continue On Fail** setting in n8n.

### Use with an AI Agent

The node is marked **Usable as AI Tool**. In an **AI Agent** node, add a tool, select **Dataify MCP**, choose **Tool: Call**, and set the tool name and JSON arguments. Expressions can be used in the arguments so the agent supplies values at runtime.

To expose every Dataify MCP server tool as a separate AI tool, use the built-in **MCP Client Tool** node in n8n with the Dataify MCP URL and Bearer authentication.

## Compatibility

Uses the MCP protocol version supported by `dataify_mcp_api` (`2025-11-25`).

## Resources

- [Dataify](https://dataify.com)
- [Dataify MCP documentation](https://doc.dataify.com/9142554m0)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/#community-nodes)

## Version history

- **0.1.0** - Initial release with dynamic tool discovery and tool calls.
