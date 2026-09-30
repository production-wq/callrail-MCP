"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
const server = new mcp_js_1.McpServer({
    name: "callrail-mcp",
    version: "1.0.0"
});
// Helper to get CallRail API key
const getApiKey = (args) => args.api_key || process.env.CALLRAIL_API_KEY;
const getHeaders = (args) => ({ Authorization: `Token token="${getApiKey(args)}"` });
server.tool("get_client_metrics", "Get the number of leads (form submissions) and calls for a client over a date range.", {
    account_id: zod_1.z.string().describe("The CallRail account ID"),
    company_id: zod_1.z.string().optional().describe("The CallRail company ID to filter by client"),
    date_range: zod_1.z.enum(["recent", "today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_year", "last_year", "all_time"]).default("this_month").describe("The date range to query"),
    api_key: zod_1.z.string().optional().describe("CallRail API key.")
}, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: CallRail API key is required." }] };
    try {
        const headers = getHeaders(args);
        const params = { date_range: args.date_range, per_page: 10 };
        if (args.company_id)
            params.company_id = args.company_id;
        const callsRes = await axios_1.default.get(`https://api.callrail.com/v3/a/${args.account_id}/calls.json`, { headers, params });
        const formsRes = await axios_1.default.get(`https://api.callrail.com/v3/a/${args.account_id}/form_submissions.json`, { headers, params });
        const totalCalls = callsRes.data.total_records;
        const totalLeads = formsRes.data.total_records;
        const recentCalls = callsRes.data.calls.map((c) => ({
            id: c.id, start_time: c.start_time, customer_phone: c.customer_phone_number, duration: c.duration, answered: c.answered
        }));
        const recentLeads = formsRes.data.form_submissions.map((f) => ({
            id: f.id, submitted_at: f.submitted_at, customer_name: f.customer_name, customer_email: f.customer_email, source: f.source
        }));
        return {
            content: [
                { type: "text", text: `Metrics for ${args.date_range}:\nTotal Calls: ${totalCalls}\nTotal Leads (Form Submissions): ${totalLeads}\n` },
                { type: "text", text: `Recent Calls:\n${JSON.stringify(recentCalls, null, 2)}` },
                { type: "text", text: `Recent Leads:\n${JSON.stringify(recentLeads, null, 2)}` }
            ]
        };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("list_companies", "List companies in a CallRail account.", { account_id: zod_1.z.string().describe("The CallRail account ID"), api_key: zod_1.z.string().optional() }, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const res = await axios_1.default.get(`https://api.callrail.com/v3/a/${args.account_id}/companies.json`, { headers: getHeaders(args), params: { per_page: 100 } });
        const companies = res.data.companies.map((c) => ({ id: c.id, name: c.name, status: c.status }));
        return { content: [{ type: "text", text: JSON.stringify(companies, null, 2) }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("list_accounts", "List all accessible CallRail accounts.", { api_key: zod_1.z.string().optional() }, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const res = await axios_1.default.get(`https://api.callrail.com/v3/a.json`, { headers: getHeaders(args), params: { per_page: 100 } });
        const accounts = res.data.accounts.map((a) => ({ id: a.id, name: a.name }));
        return { content: [{ type: "text", text: JSON.stringify(accounts, null, 2) }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("list_all_calls", "List calls with rich details.", {
    account_id: zod_1.z.string(),
    company_id: zod_1.z.string().optional(),
    date_range: zod_1.z.string().optional().default("recent").describe("e.g. recent, today, this_month"),
    per_page: zod_1.z.number().optional().default(20),
    api_key: zod_1.z.string().optional()
}, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const params = { date_range: args.date_range, per_page: args.per_page };
        if (args.company_id)
            params.company_id = args.company_id;
        const res = await axios_1.default.get(`https://api.callrail.com/v3/a/${args.account_id}/calls.json`, { headers: getHeaders(args), params });
        return { content: [{ type: "text", text: JSON.stringify(res.data.calls, null, 2) }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("get_call_details", "Get details for a specific call by ID.", {
    account_id: zod_1.z.string(),
    call_id: zod_1.z.string(),
    api_key: zod_1.z.string().optional()
}, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const res = await axios_1.default.get(`https://api.callrail.com/v3/a/${args.account_id}/calls/${args.call_id}.json`, { headers: getHeaders(args) });
        return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("update_call", "Edit a call in CallRail (e.g. add notes, tags, update customer name).", {
    account_id: zod_1.z.string(),
    call_id: zod_1.z.string(),
    note: zod_1.z.string().optional().describe("Note to add/update"),
    tags: zod_1.z.array(zod_1.z.string()).optional().describe("Tags to assign"),
    customer_name: zod_1.z.string().optional().describe("Update customer name"),
    lead_status: zod_1.z.enum(["good_lead", "not_a_lead", "not_scored"]).optional().describe("Update lead status"),
    value: zod_1.z.string().optional().describe("Monetary value (e.g. '$50.00')"),
    api_key: zod_1.z.string().optional()
}, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const data = {};
        if (args.note !== undefined)
            data.note = args.note;
        if (args.tags !== undefined)
            data.tags = args.tags;
        if (args.customer_name !== undefined)
            data.customer_name = args.customer_name;
        if (args.lead_status !== undefined)
            data.lead_status = args.lead_status;
        if (args.value !== undefined)
            data.value = args.value;
        const res = await axios_1.default.put(`https://api.callrail.com/v3/a/${args.account_id}/calls/${args.call_id}.json`, data, { headers: getHeaders(args) });
        return { content: [{ type: "text", text: `Call updated successfully:\n${JSON.stringify(res.data, null, 2)}` }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
server.tool("send_text_message", "Send an SMS text message to a customer.", {
    account_id: zod_1.z.string(),
    company_id: zod_1.z.string(),
    customer_phone_number: zod_1.z.string().describe("E.164 format e.g. +14044442233"),
    tracking_number: zod_1.z.string().describe("Your tracking number sending the message"),
    content: zod_1.z.string().describe("Text message content"),
    api_key: zod_1.z.string().optional()
}, async (args) => {
    if (!getApiKey(args))
        return { content: [{ type: "text", text: "Error: API key required." }] };
    try {
        const data = {
            company_id: args.company_id,
            customer_phone_number: args.customer_phone_number,
            tracking_number: args.tracking_number,
            content: args.content
        };
        const res = await axios_1.default.post(`https://api.callrail.com/v3/a/${args.account_id}/text-messages.json`, data, { headers: getHeaders(args) });
        return { content: [{ type: "text", text: `Text sent successfully:\n${JSON.stringify(res.data, null, 2)}` }] };
    }
    catch (error) {
        return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
    }
});
const app = (0, express_1.default)();
// Basic configurations for Web clients
app.use((0, cors_1.default)());
// Optional: Global MCP Server Authentication
const mcpAuthToken = process.env.MCP_API_KEY;
if (mcpAuthToken) {
    app.use((req, res, next) => {
        // Browsers don't send auth headers on OPTIONS preflight
        if (req.method === 'OPTIONS') {
            return next();
        }
        // Only protect /sse and /message paths
        if (req.path === '/sse' || req.path === '/message') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${mcpAuthToken}`) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or missing Bearer token' });
            }
        }
        next();
    });
}
const transports = new Map();
app.get('/sse', async (req, res) => {
    const transport = new sse_js_1.SSEServerTransport('/message', res);
    await server.connect(transport);
    transports.set(transport.sessionId, transport);
    req.on('close', () => {
        transports.delete(transport.sessionId);
    });
});
app.post('/message', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports.get(sessionId);
    if (transport) {
        await transport.handlePostMessage(req, res);
    }
    else {
        res.status(404).send('Session not found. In serverless environments, reconnect.');
    }
});
// Basic REST endpoints for ChatGPT
app.post('/api/tools/:toolName', express_1.default.json(), async (req, res) => {
    res.json({ error: "Use MCP SSE transport. OpenAPI proxy required." });
});
const transportType = process.env.TRANSPORT || 'stdio';
if (transportType === 'sse' && !process.env.VERCEL) {
    const port = process.env.PORT || 3000;
    app.listen(port, () => {
        console.log(`CallRail MCP server running on SSE transport at http://localhost:${port}`);
    });
}
else if (transportType === 'stdio' && !process.env.VERCEL) {
    const transport = new stdio_js_1.StdioServerTransport();
    server.connect(transport).then(() => {
        console.error("CallRail MCP server running on stdio transport");
    });
}
exports.default = app;
