"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const sse_js_1 = require("@modelcontextprotocol/sdk/server/sse.js");
const streamableHttp_js_1 = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const axios_1 = __importDefault(require("axios"));
const zod_1 = require("zod");
// Helper to get CallRail API key
const getApiKey = (args) => args.api_key || process.env.CALLRAIL_API_KEY;
const getHeaders = (args) => ({ Authorization: `Token token="${getApiKey(args)}"` });
// ---------------------------------------------------------------------------
// Windsor.ai-style reporting: pull every call + form submission with its
// attribution fields (source, medium, campaign, ...) and aggregate them by any
// combination of dimensions. The plain CallRail totals endpoints do not carry
// the source, so we fetch the records with the `fields` parameter and group
// them ourselves.
// ---------------------------------------------------------------------------
const CALLRAIL_BASE = process.env.CALLRAIL_BASE_URL || "https://api.callrail.com/v3";
const ATTRIBUTION_FIELDS = "company_id,company_name,source,medium,campaign,keywords,utm_source,utm_medium,utm_campaign,utm_term,utm_content,landing_page_url,lead_status";
// CallRail rejects utm_term/utm_content on form_submissions, so forms use a reduced list.
const FORM_ATTRIBUTION_FIELDS = "company_id,company_name,source,medium,campaign,keywords,utm_source,utm_medium,utm_campaign,landing_page_url,lead_status";
const CALL_FIELDS = `${ATTRIBUTION_FIELDS},first_call,tracking_phone_number`;
const DIMENSIONS = ["source", "medium", "campaign", "keywords", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "company_name", "landing_page_url", "tracking_number", "date", "month"];
async function fetchAll(url, listKey, headers, params, maxPages) {
    const records = [];
    let truncated = false;
    for (let page = 1;; page++) {
        const res = await axios_1.default.get(url, { headers, params: { per_page: 250, ...params, page } });
        records.push(...(res.data[listKey] || []));
        const totalPages = res.data.total_pages ?? 1;
        if (page >= totalPages)
            break;
        if (page >= maxPages) {
            truncated = true;
            break;
        }
    }
    return { records, truncated };
}
// Try progressively smaller `fields` lists so one unsupported field name never
// hides all records. Returns which field set worked.
async function fetchAllWithFallback(url, listKey, headers, params, maxPages, fieldSets) {
    let lastError;
    for (const fields of fieldSets) {
        try {
            const out = await fetchAll(url, listKey, headers, fields ? { ...params, fields } : params, maxPages);
            return { ...out, fields, error: undefined };
        }
        catch (e) {
            lastError = e;
            const st = e.response?.status;
            if (!st || st < 400 || st >= 500 || st === 401 || st === 403 || st === 429)
                break;
        }
    }
    return { records: [], truncated: false, fields: "", error: lastError?.response ? JSON.stringify(lastError.response.data) : lastError?.message };
}
const FORM_FIELD_SETS = [
    FORM_ATTRIBUTION_FIELDS,
    "company_id,company_name,source,medium,campaign,keywords,utm_source,utm_medium,utm_campaign,landing_page_url",
    "company_id,company_name,source,medium,campaign",
    ""
];
function dimensionValue(rec, dim, timeField) {
    switch (dim) {
        case "date": return String(rec[timeField] || "").slice(0, 10) || "(none)";
        case "month": return String(rec[timeField] || "").slice(0, 7) || "(none)";
        case "tracking_number": return rec.tracking_phone_number || "(none)";
        default: {
            const v = rec[dim];
            return v === undefined || v === null || v === "" ? "(none)" : String(v);
        }
    }
}
function createServer() {
    const server = new mcp_js_1.McpServer({
        name: "callrail-mcp",
        version: "1.1.0"
    });
    server.tool("get_client_metrics", "Get the all-source TOTAL number of calls and form submissions for a client. No per-source split - use get_marketing_data for that.", {
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
    server.tool("get_marketing_data", "Windsor.ai-style report: calls and form submissions (leads) broken down by source, medium, campaign, UTM values, company, date, etc. Use this instead of get_client_metrics whenever you need numbers PER SOURCE.", {
        account_id: zod_1.z.string().describe("The CallRail account ID"),
        company_id: zod_1.z.string().optional().describe("Limit to one company (client). Omit for all companies in the account."),
        date_range: zod_1.z.enum(["recent", "today", "yesterday", "last_7_days", "last_30_days", "this_month", "last_month", "this_year", "last_year", "all_time"]).optional().describe("Relative range. Ignored when date_from is given."),
        date_from: zod_1.z.string().optional().describe("Start date YYYY-MM-DD"),
        date_to: zod_1.z.string().optional().describe("End date YYYY-MM-DD"),
        dimensions: zod_1.z.array(zod_1.z.enum(DIMENSIONS)).default(["source"]).describe("Fields to group by, e.g. ['source'] or ['company_name','source'] or ['date','source']"),
        data_types: zod_1.z.enum(["both", "calls", "forms"]).default("both").describe("Include calls, form submissions, or both"),
        max_pages: zod_1.z.number().default(40).describe("Safety cap on pages of 250 records fetched per data type"),
        api_key: zod_1.z.string().optional().describe("CallRail API key.")
    }, async (args) => {
        if (!getApiKey(args))
            return { content: [{ type: "text", text: "Error: CallRail API key is required." }] };
        try {
            const headers = getHeaders(args);
            const params = {};
            if (args.date_from) {
                params.start_date = args.date_from;
                if (args.date_to)
                    params.end_date = args.date_to;
            }
            else {
                params.date_range = args.date_range || "this_month";
            }
            if (args.company_id)
                params.company_id = args.company_id;
            const base = `${CALLRAIL_BASE}/a/${args.account_id}`;
            const [calls, forms] = await Promise.all([
                args.data_types === "forms" ? { records: [], truncated: false } : fetchAll(`${base}/calls.json`, "calls", headers, { ...params, fields: CALL_FIELDS }, args.max_pages),
                args.data_types === "calls" ? { records: [], truncated: false } : fetchAllWithFallback(`${base}/form_submissions.json`, "form_submissions", headers, params, args.max_pages, FORM_FIELD_SETS)
            ]);
            const rows = new Map();
            const rowFor = (rec, timeField) => {
                const dims = {};
                for (const d of args.dimensions)
                    dims[d] = dimensionValue(rec, d, timeField);
                const key = JSON.stringify(dims);
                if (!rows.has(key)) {
                    rows.set(key, { ...dims, calls: 0, answered_calls: 0, missed_calls: 0, first_time_callers: 0, good_lead_calls: 0, total_call_duration_sec: 0, form_submissions: 0, good_lead_forms: 0, total_leads: 0 });
                }
                return rows.get(key);
            };
            for (const c of calls.records) {
                const r = rowFor(c, "start_time");
                r.calls++;
                if (c.answered)
                    r.answered_calls++;
                else
                    r.missed_calls++;
                if (c.first_call)
                    r.first_time_callers++;
                if (c.lead_status === "good_lead")
                    r.good_lead_calls++;
                r.total_call_duration_sec += Number(c.duration) || 0;
                r.total_leads++;
            }
            for (const f of forms.records) {
                const r = rowFor(f, "submitted_at");
                r.form_submissions++;
                if (f.lead_status === "good_lead")
                    r.good_lead_forms++;
                r.total_leads++;
            }
            const data = [...rows.values()]
                .map(r => ({ ...r, avg_call_duration_sec: r.calls ? Math.round(r.total_call_duration_sec / r.calls) : 0 }))
                .sort((a, b) => b.total_leads - a.total_leads);
            const totals = data.reduce((t, r) => ({
                calls: t.calls + r.calls, form_submissions: t.form_submissions + r.form_submissions, total_leads: t.total_leads + r.total_leads
            }), { calls: 0, form_submissions: 0, total_leads: 0 });
            const formsError = forms.error;
            const note = ((calls.truncated || forms.truncated) ? "\nWARNING: results truncated at max_pages; narrow the date range or raise max_pages." : "")
                + (formsError ? `\nWARNING: form submissions could not be fetched, so form counts are missing: ${formsError}` : "");
            return {
                content: [{
                        type: "text",
                        text: `Period: ${args.date_from ? `${args.date_from} to ${args.date_to || "today"}` : params.date_range}\nGrouped by: ${args.dimensions.join(", ")}\nRecords fetched: ${calls.records.length} calls, ${forms.records.length} form submissions\nTotals: ${JSON.stringify(totals)}${note}\n\n${JSON.stringify(data, null, 2)}`
                    }]
            };
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
        }
    });
    server.tool("list_form_submissions", "List individual form submissions (leads) with name, email, source, medium, campaign, landing page and the submitted form data.", {
        account_id: zod_1.z.string(),
        company_id: zod_1.z.string().optional(),
        date_range: zod_1.z.string().optional().default("this_month").describe("e.g. today, last_7_days, this_month"),
        date_from: zod_1.z.string().optional().describe("Start date YYYY-MM-DD"),
        date_to: zod_1.z.string().optional().describe("End date YYYY-MM-DD"),
        per_page: zod_1.z.number().optional().default(50),
        api_key: zod_1.z.string().optional()
    }, async (args) => {
        if (!getApiKey(args))
            return { content: [{ type: "text", text: "Error: API key required." }] };
        try {
            const params = { per_page: args.per_page };
            if (args.date_from) {
                params.start_date = args.date_from;
                if (args.date_to)
                    params.end_date = args.date_to;
            }
            else
                params.date_range = args.date_range;
            if (args.company_id)
                params.company_id = args.company_id;
            const out = await fetchAllWithFallback(`${CALLRAIL_BASE}/a/${args.account_id}/form_submissions.json`, "form_submissions", getHeaders(args), params, 1, [`${FORM_ATTRIBUTION_FIELDS},form_data`, ...FORM_FIELD_SETS]);
            if (out.error)
                return { content: [{ type: "text", text: `Error: ${out.error}` }] };
            return { content: [{ type: "text", text: JSON.stringify(out.records, null, 2) }] };
        }
        catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.response ? JSON.stringify(error.response.data) : error.message}` }] };
        }
    });
    return server;
}
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
        if (req.path === '/sse' || req.path === '/message' || req.path === '/mcp') {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${mcpAuthToken}`) {
                return res.status(401).json({ error: 'Unauthorized: Invalid or missing Bearer token' });
            }
        }
        next();
    });
}
const transports = new Map();
// Streamable HTTP (stateless): a fresh server per request, so it works behind
// Render/Vercel restarts and multiple instances.
app.post('/mcp', express_1.default.json({ limit: '4mb' }), async (req, res) => {
    const mcp = createServer();
    const transport = new streamableHttp_js_1.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        if (!res.headersSent)
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error.message }, id: null });
    }
});
app.get('/mcp', (_req, res) => { res.status(405).json({ error: 'Use POST /mcp' }); });
app.get('/health', (_req, res) => { res.json({ status: 'ok' }); });
app.get('/', (req, res) => {
    res.send('CallRail MCP Server is running! Use /mcp (Streamable HTTP) or /sse for MCP connections.');
});
app.get('/sse', async (req, res) => {
    const transport = new sse_js_1.SSEServerTransport('/message', res);
    const server = createServer();
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
    app.listen(Number(port), '0.0.0.0', () => {
        console.log(`CallRail MCP server running on SSE transport at http://localhost:${port}`);
    });
}
else if (transportType === 'stdio' && !process.env.VERCEL) {
    const transport = new stdio_js_1.StdioServerTransport();
    createServer().connect(transport).then(() => {
        console.error("CallRail MCP server running on stdio transport");
    });
}
exports.default = app;
