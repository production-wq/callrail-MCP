# CallRail MCP Server

This is a Model Context Protocol (MCP) server for the CallRail API. It allows AI models (like Claude, AntiGravity, Cursor, and ChatGPT via an OpenAPI proxy) to interact with CallRail to pull metrics, read calls, and even edit them.

## New Features

- **get_client_metrics**: Get total calls and leads.
- **list_companies**: Get the companies within an account.
- **list_accounts**: List accounts.
- **list_all_calls**: See a list of calls with all details.
- **get_call_details**: Fetch all metadata for a specific call.
- **update_call**: Add a note, assign tags, update customer name, or change the lead status of a specific call inside CallRail!
- **send_text_message**: Send an SMS directly to a customer from your tracking number.

## Authentication & Web Security (CORS)

By default, the server uses your `CALLRAIL_API_KEY` to authenticate against CallRail. 
However, since you're deploying this on the web (Vercel) as an SSE endpoint, you likely want to **secure your MCP server** so random people can't use your Vercel URL to query your CallRail account.

### How to Secure the MCP Server
1. Go to your Vercel Project Settings > Environment Variables.
2. Add a new variable called `MCP_API_KEY` and set it to a secure, random password (e.g. `my-super-secret-key`).
3. Now, when you add this MCP server to a web AI (like LangChain, LangSmith, or Glama), it will ask for a **Bearer Token**. You provide `my-super-secret-key`, and the AI will send it as `Authorization: Bearer my-super-secret-key` to your server. 

*(If you don't set `MCP_API_KEY`, the endpoint remains public, meaning anyone with the URL can use it. It's highly recommended to set it).*

## Using with ChatGPT

ChatGPT Custom Actions (GPTs) do not support the MCP (SSE) protocol natively yet. They require a REST OpenAPI schema. 
To use this with ChatGPT, you have two options:
1. **Use an MCP Proxy**: Use a service like **LangSmith / LangChain** or **Glama**, which allows you to import an MCP server URL, and it automatically generates the OpenAPI schema and REST endpoints for you to paste into ChatGPT.
2. **Direct Integration**: ChatGPT will need the `/api/tools/` endpoints mapped via an OpenAPI JSON. (Proxying via Smith is the most robust).

## Using with Claude & AntiGravity

### Cloud (Vercel)
Provide the URL `https://<your-vercel-deployment-url>/sse` to the AI client. If you set `MCP_API_KEY`, use it as your Bearer token.

### Local (`stdio`)
In `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "callrail": {
      "command": "node",
      "args": ["/path/to/callrail-MCP/dist/index.js"],
      "env": {
        "CALLRAIL_API_KEY": "YOUR_CALLRAIL_API_KEY"
      }
    }
  }
}
```
