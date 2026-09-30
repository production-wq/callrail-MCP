import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import cors from "cors";
import axios from "axios";
import { z } from "zod";

const server = new McpServer({
  name: "callrail-mcp",
  version: "1.0.0"
});

// Helper to get CallRail API key
const getApiKey = (args: any) => args.api_key || process.env.CALLRAIL_API_KEY;
const getHeaders = (args: any) => ({ Authorization: `Token token="${getApiKey(args)}"` });

server.tool(
  "get_client_metrics",
  "Get the number of leads (form submissions) and calls for a client over a date range.",
  {
    account_id: z.string().describe("The CallRail account ID"),
    company_id: z.string().optional().describe("The CallRail company ID to filter by client"),
    date_range: z.enum(["recent", "today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_year", "last_year", "all_time"]).default("this_month").describe("The date range to query"),
    api_key: z.string().optional().describe("CallRail API key.")
  },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: CallRail API key is required." }] };
    try {
      const headers = getHeaders(args);
      const params: any = { date_range: args.date_range, per_page: 10 };
      if (args.company_id) params.company_id = args.company_id;

      const callsRes = await axios.get(`https://api.callrail.com/v3/a/${args.account_id}/calls.json`, { headers, params });
      const formsRes = await axios.get(`https://api.callrail.com/v3/a/${args.account_id}/form_submissions.json`, { headers, params });
      
      const totalCalls = callsRes.data.total_records;
      const totalLeads = formsRes.data.total_records;
      
      const recentCalls = callsRes.data.calls.map((c: any) => ({
        id: c.id, start_time: c.start_time, customer_phone: c.customer_phone_number, duration: c.duration, answered: c.answered
      }));
      
      const recentLeads = formsRes.data.form_submissions.map((f: any) => ({
        id: f.id, submitted_at: f.submitted_at, customer_name: f.customer_name, customer_email: f.customer_email, source: f.source
      }));

      return {
        content: [
          { type: "text", text: `Metrics for ${args.date_range}:\nTotal Calls: ${totalCalls}\nTotal Leads (Form Submissions): ${totalLeads}\n` },
          { type: "text", text: `Recent Calls:\n${JSON.stringify(recentCalls, null, 2)}` },
          { type: "text", text: `Recent Leads:\n${JSON.stringify(recentLeads, null, 2)}` }
        ]
      };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "list_companies",
  "List companies in a CallRail account.",
  { account_id: z.string().describe("The CallRail account ID"), api_key: z.string().optional() },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const res = await axios.get(`https://api.callrail.com/v3/a/${args.account_id}/companies.json`, { headers: getHeaders(args), params: { per_page: 100 } });
      const companies = res.data.companies.map((c: any) => ({ id: c.id, name: c.name, status: c.status }));
      return { content: [{ type: "text", text: JSON.stringify(companies, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "list_accounts",
  "List all accessible CallRail accounts.",
  { api_key: z.string().optional() },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const res = await axios.get(`https://api.callrail.com/v3/a.json`, { headers: getHeaders(args), params: { per_page: 100 } });
      const accounts = res.data.accounts.map((a: any) => ({ id: a.id, name: a.name }));
      return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "list_all_calls",
  "List calls with rich details.",
  {
    account_id: z.string(),
    company_id: z.string().optional(),
    date_range: z.string().optional().default("recent").describe("e.g. recent, today, this_month"),
    per_page: z.number().optional().default(20),
    api_key: z.string().optional()
  },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const params: any = { date_range: args.date_range, per_page: args.per_page };
      if (args.company_id) params.company_id = args.company_id;
      const res = await axios.get(`https://api.callrail.com/v3/a/${args.account_id}/calls.json`, { headers: getHeaders(args), params });
      return { content: [{ type: "text", text: JSON.stringify(res.data.calls, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "get_call_details",
  "Get details for a specific call by ID.",
  {
    account_id: z.string(),
    call_id: z.string(),
    api_key: z.string().optional()
  },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const res = await axios.get(`https://api.callrail.com/v3/a/${args.account_id}/calls/${args.call_id}.json`, { headers: getHeaders(args) });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "update_call",
  "Edit a call in CallRail (e.g. add notes, tags, update customer name).",
  {
    account_id: z.string(),
    call_id: z.string(),
    note: z.string().optional().describe("Note to add/update"),
    tags: z.array(z.string()).optional().describe("Tags to assign"),
    customer_name: z.string().optional().describe("Update customer name"),
    lead_status: z.enum(["good_lead", "not_a_lead", "not_scored"]).optional().describe("Update lead status"),
    value: z.string().optional().describe("Monetary value (e.g. '$50.00')"),
    api_key: z.string().optional()
  },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const data: any = {};
      if (args.note !== undefined) data.note = args.note;
      if (args.tags !== undefined) data.tags = args.tags;
      if (args.customer_name !== undefined) data.customer_name = args.customer_name;
      if (args.lead_status !== undefined) data.lead_status = args.lead_status;
      if (args.value !== undefined) data.value = args.value;

      const res = await axios.put(`https://api.callrail.com/v3/a/${args.account_id}/calls/${args.call_id}.json`, data, { headers: getHeaders(args) });
      return { content: [{ type: "text", text: `Call updated successfully:\n${JSON.stringify(res.data, null, 2)}` }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

server.tool(
  "send_text_message",
  "Send an SMS text message to a customer.",
  {
    account_id: z.string(),
    company_id: z.string(),
    customer_phone_number: z.string().describe("E.164 format e.g. +14044442233"),
    tracking_number: z.string().describe("Your tracking number sending the message"),
    content: z.string().describe("Text message content"),
    api_key: z.string().optional()
  },
  async (args) => {
    if (!getApiKey(args)) return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
      const data = {
        company_id: args.company_id,
        customer_phone_number: args.customer_phone_number,
        tracking_number: args.tracking_number,
        content: args.content
      };
      const res = await axios.post(`https://api.callrail.com/v3/a/${args.account_id}/text-messages.json`, data, { headers: getHeaders(args) });
      return { content: [{ type: "text", text: `Text sent successfully:\n${JSON.stringify(res.data, null, 2)}` }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
  }
);

const transportType = process.env.TRANSPORT || 'stdio';

if (transportType === 'sse' || process.env.VERCEL) {
  const app = express();
  
  // Basic configurations for Web clients
  app.use(cors());
  app.use(express.json());

  // Optional: Global MCP Server Authentication
  // If MCP_API_KEY environment variable is set on Vercel, we check it via Bearer token
  const mcpAuthToken = process.env.MCP_API_KEY;
  if (mcpAuthToken) {
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${mcpAuthToken}`) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing Bearer token' });
      }
      next();
    });
  }

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

  // Basic REST endpoints to enable ChatGPT actions (OpenAPI fallback)
  app.post('/api/tools/:toolName', async (req, res) => {
    const { toolName } = req.params;
    try {
       // @ts-ignore - reaching into internals to execute for standard REST clients
       const tool = server._tools?.[toolName] || (server as any).tools?.[toolName];
       if (!tool && !(server as any).registeredTools) {
           return res.status(404).json({ error: "Tool not found or internal server mapping changed." });
       }
       
       // For MCP SDK, we can dispatch a JSONRPC request manually or just route it.
       // However, to keep it simple without internals, let's just create an internal router for ChatGPT
       res.json({ error: "To support ChatGPT, please use a hosted MCP-to-OpenAPI proxy or configure the OpenAPI schema for these endpoints." });
    } catch (err: any) {
       res.status(500).json({ error: err.message });
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
