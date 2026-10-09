import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { EventSource } from "eventsource";

async function run() {
  console.log("Connecting to live Vercel app...");
  
  // Custom EventSource to inject the Auth header
  class CustomEventSource extends EventSource {
    constructor(url, init) {
      super(url, {
        ...init,
        headers: {
          ...init?.headers,
          "Authorization": "Bearer my-FGH-hdcgsbs-hcdhhcGCsj-123F@U"
        }
      });
    }
  }
  
  // Override global EventSource used by the SDK
  global.EventSource = CustomEventSource;

  const transport = new SSEClientTransport(
    new URL("https://callrail-mcp.vercel.app/sse"),
    {
      requestInit: {
        headers: {
          "Authorization": "Bearer my-FGH-hdcgsbs-hcdhhcGCsj-123F@U"
        }
      }
    }
  );
  
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await client.connect(transport);
    console.log("✅ Successfully connected to Vercel via SSE!");
    
    const tools = await client.listTools();
    console.log("✅ Successfully fetched tools list!");
    console.log(`Found ${tools.tools.length} tools:`, tools.tools.map(t => t.name).join(", "));
    
    process.exit(0);
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

run();
