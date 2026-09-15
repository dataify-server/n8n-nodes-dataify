# n8n-nodes-dataify

Dataify MCP 的 n8n 社区节点。它把工作流连接到 Dataify MCP API，并在运行时动态发现当前 Token 可见的全部工具——Dataify 新增工具后无需升级节点包即可直接使用。

## 安装

在自托管 n8n 中通过 **Settings → Community Nodes** 安装：

1. 进入 **Settings → Community Nodes**；
2. 点击 **Install**，搜索 `n8n-nodes-dataify` 并安装。

更多信息可参考 [n8n 社区节点安装指南](https://docs.n8n.io/integrations/community-nodes/installation/)。

## 支持的操作

- **Tool: Call（调用工具）**：选择或手动输入一个 MCP 工具名，传入 JSON 参数对象进行调用。
- **Server: List Tools（列出工具）**：返回当前 API Token 可见的全部工具，可选择是否附带 JSON Schema。

## 凭据配置

创建一个 **Dataify MCP API** 凭据，需要填写：

- **Server URL**：Dataify MCP 服务地址，节点会自动补全 `/mcp`。
- **API Token**：从 Dataify 控制台获取，由 n8n 加密存储，并通过 `Authorization: Bearer` 头发送。
- **Allow Insecure HTTP**：默认关闭，仅当可信私有部署无法使用 HTTPS 时开启。
- **Allow Private IP Address**：默认关闭，仅当可信自托管地址包含内网 IP 时开启；回环地址无需开启。
- **Allowed Tools**：可选，逗号分隔的工具或分类编码，作为 `tools` 查询参数传递。

默认服务地址为 `https://mcp.dataify.com`。自定义远程服务默认必须使用 HTTPS，API Token 永远不会拼进 URL。

## 使用说明

从动态列表中选择工具，或直接输入工具的 MCP 名称。**Arguments** 必须是符合该工具输入 Schema 的 JSON 对象。开启 **Simplify Output** 时优先返回 `structuredContent`，关闭则返回完整的 MCP 工具结果。

节点支持 Dataify 服务的 Streamable HTTP 传输，兼容缓冲 JSON 与 Server-Sent Events（SSE）两种响应。每个输入项独立执行，并支持 n8n 的 **Continue On Fail** 设置。

### 与 AI Agent 配合使用

节点已标记为 **Usable as AI Tool**。在 **AI Agent** 节点中添加工具，选择 **Dataify MCP**，再选 **Tool: Call**，配置工具名和 JSON 参数即可；参数中可以使用表达式，由 Agent 在运行时动态赋值。

若要把 Dataify MCP 服务端每个工具都暴露为独立 AI 工具，请使用 n8n 内置的 **MCP Client Tool** 节点，并配置 Dataify MCP 地址和 Bearer 鉴权。

## 兼容性

使用 `dataify_mcp_api` 支持的 MCP 协议版本 `2025-11-25`。

## 资源

- [Dataify](https://dataify.com)
- [Dataify MCP 文档](https://doc.dataify.com/9142554m0)
- [n8n 社区节点文档](https://docs.n8n.io/integrations/#community-nodes)

## 版本历史

- **0.1.0** - 首个版本，支持动态工具发现与工具调用。
