# CallRail MCP Server

This is a Model Context Protocol (MCP) server for the CallRail API. It allows AI models (like Claude, AntiGravity, Cursor, and ChatGPT via an OpenAPI proxy) to interact with CallRail to pull metrics, read calls, and even edit them.

## New Features

- **get_marketing_data** (Windsor.ai-style): calls + form submissions broken down by `source`, `medium`, `campaign`, `utm_*`, `company_name`, `date`, `month`, etc. Example: `dimensions: ["source"]`, `date_from: "2026-09-01"`, `date_to: "2026-09-30"`. Omit `company_id` to cover every client in the account (add `company_name` to dimensions to split them).

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

## Using with ChatGPT (OAuth)

The server is a standards-compliant OAuth 2.1 authorization server, so ChatGPT's MCP connector can connect directly.

Required env vars: `JWT_SECRET`, `OAUTH_USERNAME`, `OAUTH_PASSWORD` (plus `CALLRAIL_API_KEY`). See `.env.example`.

In ChatGPT (Settings → Apps/Connectors → Developer mode → Create):
- **MCP server URL**: `https://<your-deployment>/mcp`
- **Authentication**: OAuth, leave the client fields on automatic registration (Dynamic Client Registration).
- ChatGPT opens the sign-in page; log in with `OAUTH_USERNAME` / `OAUTH_PASSWORD`.

If you would rather paste a fixed client, set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` and enter the same values in ChatGPT.

How it works:
- Unauthenticated calls get `401` + `WWW-Authenticate: Bearer resource_metadata=...`
- Discovery: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`
- Endpoints: `/oauth/register` (RFC 7591), `/oauth/authorize`, `/oauth/token`
- PKCE `S256` is required; redirect URIs are restricted to ChatGPT / Claude / Perplexity / localhost (add more via `OAUTH_ALLOWED_REDIRECT_URIS`).
- Fully stateless (signed JWTs), so it works on Vercel's serverless instances and survives restarts.
- `MCP_API_KEY` bearer auth keeps working for Claude and Perplexity.

The legacy REST endpoints (`/api/tools/*`, `/openapi.json`) still exist for Custom GPT Actions.

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
      "args": ["/path/to/callrail-MCP/api/index.ts"],
      "env": {
        "CALLRAIL_API_KEY": "YOUR_CALLRAIL_API_KEY"
      }
    }
  }
}
```


## Deploying on Render

- Build command: `npm install && npm run build`
- Start command: `npm start` (sets `TRANSPORT=sse`, listens on Render's `$PORT`)
- Env vars: `CALLRAIL_API_KEY` (required), `MCP_API_KEY` (recommended)
- Health check path: `/health`
- Connect clients to `https://<service>.onrender.com/mcp` (Streamable HTTP, preferred) or `/sse`.
- Free instances sleep after inactivity; the first request after a sleep is slow.
