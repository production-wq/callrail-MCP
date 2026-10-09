import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
const server = new McpServer({ name: "test", version: "1" });
server.tool("test_tool", "desc", {}, async () => ({ content: [{type: "text", text: "hello"}] }));
console.log(server._registeredTools);
