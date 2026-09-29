# CallRail MCP Server

This is a Model Context Protocol (MCP) server for the CallRail API. It allows AI models (like Claude, ChatGPT with an appropriate proxy, etc.) to query CallRail for client calls and leads (form submissions).

## Features

- **get_client_metrics**: Get the total number of calls and leads (form submissions) for an account over a specific date range, as well as a list of recent calls and leads.
- **list_companies**: Get the companies within a CallRail account.
- **list_accounts**: List the accounts you have access to.

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- A CallRail API key (found in your CallRail account under Settings > View Profile > API Keys).

### Installation

```bash
git clone <repository_url>
cd callrail-MCP
npm install
npm run build
```

### Configuration

You can either pass the API key to the tools dynamically, or provide it via an environment variable. Setting it via the environment variable is recommended for security.

```bash
export CALLRAIL_API_KEY="your-api-key"
```

## Running the Server

### For Claude Desktop (Local)

Claude Desktop uses standard input/output (stdio) to communicate with MCP servers.
To use this server in Claude Desktop, add the following to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "callrail": {
      "command": "node",
      "args": ["/path/to/your/callrail-MCP/dist/index.js"],
      "env": {
        "CALLRAIL_API_KEY": "your-api-key"
      }
    }
  }
}
```

### For Hosted Clients (SSE)

If you are using a client that connects via HTTP/SSE (Server-Sent Events), you can start the server in SSE mode:

```bash
npm run start:sse
```

The server will run at `http://localhost:3000/sse`.

## Deploying to Vercel

If you'd like to push this to Vercel to make it available for your colleagues:
1. Make sure your Vercel project's Build Command is `npm run build` and the Output Directory is `dist`.
2. Vercel's serverless environment can run the SSE endpoint! Simply add an `api/index.js` wrapper if you prefer Vercel Serverless Functions, or just define it as a standard Node.js Express app deployed on Vercel. 
3. *Vercel Deployment tip:* Create a `vercel.json` to rewrite all requests to `dist/index.js` and set the `TRANSPORT` environment variable.
4. Make sure to add `CALLRAIL_API_KEY` to your Vercel Environment Variables.

**Note on Vercel**: Standard Vercel Serverless Functions have timeouts (e.g. 10s or 60s). SSE connections might be disconnected by Vercel after the timeout. If you experience timeout issues, consider deploying to a platform that supports persistent Node processes (like Render, Railway, or Heroku), or configuring the function as a Vercel Edge function.
