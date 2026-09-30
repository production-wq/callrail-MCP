import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function run() {
  console.log("Starting MCP Client test...");
  
  // Connect to the local server
  const transport = new SSEClientTransport(new URL("http://localhost:4000/sse"));
  
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Successfully connected to MCP server via SSE!");
    
    const tools = await client.listTools();
    console.log("✅ Successfully fetched tools list!");
    console.log(`Found ${tools.tools.length} tools:`, tools.tools.map(t => t.name).join(", "));
    
    console.log("All tests passed!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

run();
