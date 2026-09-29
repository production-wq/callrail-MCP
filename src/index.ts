import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import axios from "axios";
import { z } from "zod";

const server = new McpServer({
  name: "callrail-mcp",
  version: "1.0.0"
});

server.tool(
  "get_client_metrics",
  "Get the number of leads (form submissions) and calls for a client over a date range.",
  {
    account_id: z.string().describe("The CallRail account ID"),
    company_id: z.string().optional().describe("The CallRail company ID to filter by client"),
    date_range: z.enum(["recent", "today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_year", "last_year", "all_time"]).default("this_month").describe("The date range to query"),
    api_key: z.string().optional().describe("CallRail API key. Can also be set via CALLRAIL_API_KEY environment variable.")
  },
  async (args) => {
    const apiKey = args.api_key || process.env.CALLRAIL_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Error: CallRail API key is required. Pass it as a parameter or set CALLRAIL_API_KEY." }]
      };
    }

    try {
      const headers = { Authorization: `Token token="${apiKey}"` };
      
      const params: any = {
        date_range: args.date_range,
        per_page: 10
      };
      if (args.company_id) {
        params.company_id = args.company_id;
      }

      // Fetch Calls
      const callsUrl = `https://api.callrail.com/v3/a/${args.account_id}/calls.json`;
      const callsRes = await axios.get(callsUrl, { headers, params });
      
      // Fetch Form Submissions (Leads)
      const formsUrl = `https://api.callrail.com/v3/a/${args.account_id}/form_submissions.json`;
      const formsRes = await axios.get(formsUrl, { headers, params });
      
      const totalCalls = callsRes.data.total_records;
      const totalLeads = formsRes.data.total_records;
      
      const recentCalls = callsRes.data.calls.map((c: any) => ({
        id: c.id,
        start_time: c.start_time,
        customer_phone: c.customer_phone_number,
        duration: c.duration,
        answered: c.answered
      }));
      
      const recentLeads = formsRes.data.form_submissions.map((f: any) => ({
        id: f.id,
        submitted_at: f.submitted_at,
        customer_name: f.customer_name,
        customer_email: f.customer_email,
        source: f.source
      }));

      const summary = `Metrics for ${args.date_range}:\nTotal Calls: ${totalCalls}\nTotal Leads (Form Submissions): ${totalLeads}\n`;
      
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: `Recent Calls:\n${JSON.stringify(recentCalls, null, 2)}` },
          { type: "text", text: `Recent Leads:\n${JSON.stringify(recentLeads, null, 2)}` }
        ]
      };
    } catch (error: any) {
      const msg = error.response ? JSON.stringify(error.response.data) : error.message;
      return {
        content: [{ type: "text", text: `Error fetching CallRail data: ${msg}` }]
      };
    }
  }
);

server.tool(
  "list_companies",
  "List companies in a CallRail account to get their company_ids.",
  {
    account_id: z.string().describe("The CallRail account ID"),
    api_key: z.string().optional().describe("CallRail API key.")
  },
  async (args) => {
    const apiKey = args.api_key || process.env.CALLRAIL_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Error: CallRail API key is required." }]
      };
    }

    try {
      const headers = { Authorization: `Token token="${apiKey}"` };
      const url = `https://api.callrail.com/v3/a/${args.account_id}/companies.json`;
      const res = await axios.get(url, { headers, params: { per_page: 100 } });
      
      const companies = res.data.companies.map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status
      }));
      
      return {
        content: [{ type: "text", text: JSON.stringify(companies, null, 2) }]
      };
    } catch (error: any) {
      const msg = error.response ? JSON.stringify(error.response.data) : error.message;
      return {
        content: [{ type: "text", text: `Error fetching CallRail data: ${msg}` }]
      };
    }
  }
);

server.tool(
  "list_accounts",
  "List all CallRail accounts accessible by the API key.",
  {
    api_key: z.string().optional().describe("CallRail API key.")
  },
  async (args) => {
    const apiKey = args.api_key || process.env.CALLRAIL_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "Error: CallRail API key is required." }]
      };
    }

    try {
      const headers = { Authorization: `Token token="${apiKey}"` };
      const url = `https://api.callrail.com/v3/a.json`;
      const res = await axios.get(url, { headers, params: { per_page: 100 } });
      
      const accounts = res.data.accounts.map((a: any) => ({
        id: a.id,
        name: a.name
      }));
      
      return {
        content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }]
      };
    } catch (error: any) {
      const msg = error.response ? JSON.stringify(error.response.data) : error.message;
      return {
        content: [{ type: "text", text: `Error fetching CallRail data: ${msg}` }]
      };
    }
  }
);

const transportType = process.env.TRANSPORT || 'stdio';

if (transportType === 'sse' || process.env.VERCEL) {
  const app = express();
  let transport: SSEServerTransport | null = null;
  
  app.get('/sse', async (req, res) => {
    transport = new SSEServerTransport('/message', res);
    await server.connect(transport);
  });
  
  app.post('/message', async (req, res) => {
    if (transport) {
      await transport.handlePostMessage(req, res);
    } else {
      res.status(500).send('SSE not initialized');
    }
  });
  
  if (!process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
      console.log(`CallRail MCP server running on SSE transport at http://localhost:${port}`);
    });
  }
  
  module.exports = app;
} else {
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("CallRail MCP server running on stdio transport");
  });
}
