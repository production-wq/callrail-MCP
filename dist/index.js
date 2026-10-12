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
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
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
app.set('trust proxy', true);
// =============================================================================
// OAuth 2.1 Authorization Server (for ChatGPT / any MCP client that needs OAuth)
//
// Fully STATELESS: authorization codes, refresh tokens and dynamically
// registered clients are all signed JWTs. Nothing is kept in memory, so this
// works on Vercel where /authorize and /token can hit different instances.
// =============================================================================
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || '';
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || '';
const OAUTH_USERNAME = process.env.OAUTH_USERNAME || '';
const OAUTH_PASSWORD = process.env.OAUTH_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const mcpAuthToken = process.env.MCP_API_KEY;
const OAUTH_ENABLED = Boolean(JWT_SECRET && OAUTH_USERNAME && OAUTH_PASSWORD);
if (!OAUTH_ENABLED) {
    console.error('[oauth] OAuth disabled: set JWT_SECRET, OAUTH_USERNAME and OAUTH_PASSWORD to enable it.');
}
const SCOPES = ['read', 'write'];
const ACCESS_TTL = 60 * 60; // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days
const CODE_TTL = 120; // 2 minutes
// Redirect URIs OAuth clients may use. Extra exact URIs: OAUTH_ALLOWED_REDIRECT_URIS (comma separated).
const REDIRECT_ALLOWLIST = [
    /^https:\/\/chatgpt\.com\/(connector_platform_oauth_redirect|connector\/oauth\/[^/?#]+|aip\/[^/?#]+\/oauth\/callback)$/,
    /^https:\/\/chat\.openai\.com\/(connector_platform_oauth_redirect|connector\/oauth\/[^/?#]+|aip\/[^/?#]+\/oauth\/callback)$/,
    /^https:\/\/platform\.openai\.com\/apps-manage\/oauth$/,
    /^https:\/\/claude\.(ai|com)\/api\/mcp\/auth_callback$/,
    /^https:\/\/([a-z0-9-]+\.)?perplexity\.ai\/.*$/,
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/.*$/
];
const EXTRA_REDIRECTS = (process.env.OAUTH_ALLOWED_REDIRECT_URIS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAllowlistedRedirect = (uri) => EXTRA_REDIRECTS.includes(uri) || REDIRECT_ALLOWLIST.some(r => r.test(uri));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const s256 = (verifier) => crypto_1.default.createHash('sha256').update(verifier).digest('base64url');
// Constant-time string compare (hashes first so lengths never leak).
function safeEqual(a, b) {
    const ha = crypto_1.default.createHash('sha256').update(a).digest();
    const hb = crypto_1.default.createHash('sha256').update(b).digest();
    return crypto_1.default.timingSafeEqual(ha, hb);
}
function baseUrl(req) {
    const configured = process.env.PUBLIC_BASE_URL;
    if (configured)
        return configured.replace(/\/+$/, '');
    const host = req.get('host') || 'localhost';
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
    return `${local ? req.protocol : 'https'}://${host}`;
}
const derivedClientSecret = (clientId) => crypto_1.default.createHmac('sha256', JWT_SECRET).update(`client-secret:${clientId}`).digest('hex');
function resolveClient(clientId) {
    if (!clientId || !JWT_SECRET)
        return null;
    // 1. The pre-configured client (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET)
    if (OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && safeEqual(clientId, OAUTH_CLIENT_ID)) {
        return { id: OAUTH_CLIENT_ID, name: 'CallRail MCP client', redirectUris: null, secret: OAUTH_CLIENT_SECRET };
    }
    // 2. A client created through Dynamic Client Registration (client_id is a signed JWT)
    try {
        const p = jsonwebtoken_1.default.verify(clientId, JWT_SECRET, { algorithms: ['HS256'] });
        if (p.type === 'client') {
            return { id: clientId, name: p.name || 'MCP client', redirectUris: p.ru || [], secret: p.conf ? derivedClientSecret(clientId) : undefined };
        }
    }
    catch { /* not a registered client */ }
    return null;
}
const redirectAllowed = (client, uri) => client.redirectUris ? client.redirectUris.includes(uri) : isAllowlistedRedirect(uri);
// ── Tokens ───────────────────────────────────────────────────────────────────
function issueTokens(clientId, scope, aud) {
    const access_token = jsonwebtoken_1.default.sign({ type: 'access', cid: clientId, scope, aud }, JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL });
    const refresh_token = jsonwebtoken_1.default.sign({ type: 'refresh', cid: clientId, scope, aud }, JWT_SECRET, { algorithm: 'HS256', expiresIn: REFRESH_TTL });
    return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope };
}
function verifyAccessToken(token) {
    if (!JWT_SECRET)
        return false;
    try {
        return jsonwebtoken_1.default.verify(token, JWT_SECRET, { algorithms: ['HS256'] }).type === 'access';
    }
    catch {
        return false;
    }
}
// Best-effort single-use enforcement for auth codes (per instance; PKCE + 2 min expiry cover the rest).
const usedCodes = new Set();
// ── CORS (browser based MCP clients, e.g. MCP Inspector) ──────────────────────
app.use((0, cors_1.default)({ exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id'] }));
// ── Auth middleware for the MCP / tool endpoints ─────────────────────────────
app.use((req, res, next) => {
    if (req.method === 'OPTIONS')
        return next();
    const isProtected = req.path === '/sse' || req.path === '/message' || req.path === '/mcp' ||
        req.path.startsWith('/api/tools');
    if (!isProtected)
        return next();
    const authHeader = req.headers.authorization || '';
    const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
    const bearer = (authHeader.match(/^Bearer (.+)$/i) || [])[1] || '';
    const presented = bearer || queryToken;
    // 1. Static API key (Claude / Perplexity)
    if (mcpAuthToken && presented && safeEqual(presented, mcpAuthToken))
        return next();
    // 2. OAuth access token (ChatGPT)
    if (presented && verifyAccessToken(presented))
        return next();
    // Tell the client where to authenticate (RFC 9728 / MCP authorization spec).
    const suffix = req.path === '/mcp' || req.path === '/sse' ? req.path : '';
    const challenge = [`Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource${suffix}"`, `scope="${SCOPES.join(' ')}"`];
    if (presented)
        challenge.push('error="invalid_token"');
    res.set('WWW-Authenticate', challenge.join(', '));
    return res.status(401).json({ error: 'unauthorized', error_description: 'A valid access token is required.' });
});
// ── Discovery ────────────────────────────────────────────────────────────────
// RFC 9728: where to find the authorization server for this MCP server.
app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*path'], (req, res) => {
    const base = baseUrl(req);
    const p = req.params.path;
    const resourcePath = p ? '/' + (Array.isArray(p) ? p.join('/') : p) : '/mcp';
    res.json({
        resource: `${base}${resourcePath}`,
        authorization_servers: [base],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header'],
        resource_name: 'CallRail MCP'
    });
});
// RFC 8414 (also served as openid-configuration for clients that only look there).
const authServerMetadata = (req, res) => {
    const base = baseUrl(req);
    res.json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        scopes_supported: SCOPES,
        authorization_response_iss_parameter_supported: true
    });
};
app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/*path'], authServerMetadata);
app.get(['/.well-known/openid-configuration', '/.well-known/openid-configuration/*path'], authServerMetadata);
// ── Dynamic Client Registration (RFC 7591) ───────────────────────────────────
app.post('/oauth/register', express_1.default.json(), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    if (!OAUTH_ENABLED)
        return res.status(503).json({ error: 'temporarily_unavailable', error_description: 'OAuth is not configured on this server.' });
    const m = req.body || {};
    const uris = Array.isArray(m.redirect_uris) ? m.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!uris.length || !uris.every(isAllowlistedRedirect)) {
        return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris missing or not on the allowlist.' });
    }
    const method = m.token_endpoint_auth_method || 'client_secret_basic';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
        return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'Unsupported token_endpoint_auth_method.' });
    }
    const name = String(m.client_name || 'MCP client').slice(0, 80);
    const confidential = method !== 'none';
    const clientId = jsonwebtoken_1.default.sign({ type: 'client', name, ru: uris, conf: confidential }, JWT_SECRET, { algorithm: 'HS256' });
    console.log(`[oauth] registered client "${name}" method=${method}`);
    return res.status(201).json({
        client_id: clientId,
        ...(confidential ? { client_secret: derivedClientSecret(clientId), client_secret_expires_at: 0 } : {}),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: uris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: method,
        scope: SCOPES.join(' ')
    });
});
// ── Authorization endpoint ───────────────────────────────────────────────────
function errorPage(res, message) {
    res.status(400).type('html').send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Authorization error</title></head>
<body style="font-family:sans-serif;max-width:480px;margin:80px auto;color:#0f172a"><h2>Authorization error</h2><p>${esc(message)}</p></body></html>`);
}
function loginPage(res, f, client, failed) {
    const hidden = ['client_id', 'redirect_uri', 'state', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
        .map(k => `<input type="hidden" name="${k}" value="${esc(f[k])}">`).join('\n    ');
    res.status(failed ? 401 : 200).type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CallRail MCP — Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f172a; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; }
    .card { background: #1e293b; border-radius: 16px; padding: 40px 36px;
            width: 100%; max-width: 400px; box-shadow: 0 25px 50px rgba(0,0,0,.5); }
    .logo { font-size: 28px; font-weight: 700; color: #38bdf8; text-align: center; margin-bottom: 8px; }
    .subtitle { color: #94a3b8; font-size: 14px; text-align: center; margin-bottom: 32px; line-height: 1.5; }
    label { display: block; color: #cbd5e1; font-size: 13px; font-weight: 500; margin-bottom: 6px; }
    input[type=text], input[type=password] { width: 100%; padding: 12px 14px; border-radius: 8px; border: 1px solid #334155;
            background: #0f172a; color: #f1f5f9; font-size: 15px; outline: none;
            transition: border-color .2s; margin-bottom: 18px; }
    input:focus { border-color: #38bdf8; }
    button { width: 100%; padding: 13px; border-radius: 8px; border: none;
             background: #38bdf8; color: #0f172a; font-size: 16px; font-weight: 700;
             cursor: pointer; transition: background .2s; }
    button:hover { background: #7dd3fc; }
    .error { color: #f87171; font-size: 13px; margin-bottom: 16px; text-align: center; }
  </style>
</head>
<body>
<div class="card">
  <div class="logo">📞 CallRail MCP</div>
  <div class="subtitle"><strong>${esc(client.name)}</strong> wants read &amp; write access to your CallRail data.</div>
  ${failed ? '<div class="error">Invalid username or password. Please try again.</div>' : ''}
  <form method="POST" action="/oauth/authorize">
    ${hidden}
    <label for="username">Username</label>
    <input type="text" id="username" name="username" autocomplete="username" required autofocus>
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required>
    <button type="submit">Authorize →</button>
  </form>
</div>
</body>
</html>`);
}
// Shared by GET and POST. Returns the client, or sends an error page and returns null.
// Problems with client_id / redirect_uri are NEVER redirected (RFC 6749 §4.1.2.1).
function checkAuthRequest(f, res) {
    if (!OAUTH_ENABLED) {
        errorPage(res, 'OAuth is not configured on this server.');
        return null;
    }
    const client = resolveClient(f.client_id);
    if (!client) {
        errorPage(res, 'Unknown client_id.');
        return null;
    }
    if (!f.redirect_uri || !redirectAllowed(client, f.redirect_uri)) {
        errorPage(res, 'This redirect_uri is not allowed for this client.');
        return null;
    }
    return client;
}
function redirectWithError(res, base, f, error, description) {
    const target = new URL(f.redirect_uri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (f.state)
        target.searchParams.set('state', f.state);
    target.searchParams.set('iss', base);
    return res.redirect(303, target.toString());
}
// Protocol-level validation (after client + redirect are known good). Returns an error code/description or null.
function authRequestProblem(f, client) {
    if (f.response_type !== 'code')
        return ['unsupported_response_type', 'Only response_type=code is supported.'];
    if (f.code_challenge) {
        if (f.code_challenge_method !== 'S256')
            return ['invalid_request', 'code_challenge_method must be S256.'];
    }
    else if (!client.secret) {
        return ['invalid_request', 'PKCE (code_challenge with S256) is required for public clients.'];
    }
    return null;
}
const AUTH_FIELDS = ['client_id', 'redirect_uri', 'state', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'resource'];
const pickFields = (src) => Object.fromEntries(AUTH_FIELDS.map(k => [k, typeof src?.[k] === 'string' ? src[k] : '']));
app.get('/oauth/authorize', (req, res) => {
    const f = pickFields(req.query);
    const client = checkAuthRequest(f, res);
    if (!client)
        return;
    const problem = authRequestProblem(f, client);
    if (problem)
        return redirectWithError(res, baseUrl(req), f, problem[0], problem[1]);
    loginPage(res, f, client, false);
});
app.post('/oauth/authorize', express_1.default.urlencoded({ extended: false }), async (req, res) => {
    const f = pickFields(req.body);
    const client = checkAuthRequest(f, res);
    if (!client)
        return;
    const problem = authRequestProblem(f, client);
    if (problem)
        return redirectWithError(res, baseUrl(req), f, problem[0], problem[1]);
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const userOk = safeEqual(username, OAUTH_USERNAME);
    const passOk = safeEqual(password, OAUTH_PASSWORD);
    if (!(userOk && passOk)) {
        await new Promise(r => setTimeout(r, 500)); // slow down guessing
        console.warn('[oauth] failed sign-in attempt');
        return loginPage(res, f, client, true);
    }
    const base = baseUrl(req);
    const scope = f.scope || SCOPES.join(' ');
    const code = jsonwebtoken_1.default.sign({ type: 'code', cid: client.id, ru: f.redirect_uri, cc: f.code_challenge || null, scope, res: f.resource || `${base}/mcp`, jti: crypto_1.default.randomUUID() }, JWT_SECRET, { algorithm: 'HS256', expiresIn: CODE_TTL });
    const target = new URL(f.redirect_uri);
    target.searchParams.set('code', code);
    if (f.state)
        target.searchParams.set('state', f.state);
    target.searchParams.set('iss', base);
    console.log(`[oauth] authorized client "${client.name}"`);
    return res.redirect(303, target.toString());
});
// ── Token endpoint ───────────────────────────────────────────────────────────
app.post('/oauth/token', express_1.default.urlencoded({ extended: false }), express_1.default.json(), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    const oauthError = (status, error, description) => res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
    if (!OAUTH_ENABLED)
        return oauthError(503, 'temporarily_unavailable', 'OAuth is not configured on this server.');
    const b = req.body || {};
    let clientId = b.client_id;
    let clientSecret = b.client_secret;
    const basic = (req.headers.authorization || '').match(/^Basic (.+)$/i);
    if (basic) {
        try {
            const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
            const i = decoded.indexOf(':');
            clientId = decodeURIComponent(decoded.slice(0, i));
            clientSecret = decodeURIComponent(decoded.slice(i + 1));
        }
        catch {
            return oauthError(401, 'invalid_client', 'Malformed Basic credentials.');
        }
    }
    const client = resolveClient(clientId);
    if (!client)
        return oauthError(401, 'invalid_client', 'Unknown client.');
    if (client.secret && !(typeof clientSecret === 'string' && safeEqual(clientSecret, client.secret))) {
        return oauthError(401, 'invalid_client', 'Bad client credentials.');
    }
    if (b.grant_type === 'authorization_code') {
        let p;
        try {
            p = jsonwebtoken_1.default.verify(String(b.code || ''), JWT_SECRET, { algorithms: ['HS256'] });
        }
        catch {
            return oauthError(400, 'invalid_grant', 'Invalid or expired authorization code.');
        }
        if (p.type !== 'code' || p.cid !== client.id)
            return oauthError(400, 'invalid_grant', 'Code was not issued to this client.');
        if (b.redirect_uri !== undefined && b.redirect_uri !== p.ru)
            return oauthError(400, 'invalid_grant', 'redirect_uri mismatch.');
        if (usedCodes.has(p.jti))
            return oauthError(400, 'invalid_grant', 'Authorization code already used.');
        if (p.cc) {
            const v = typeof b.code_verifier === 'string' ? b.code_verifier : '';
            if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(v) || !safeEqual(s256(v), p.cc)) {
                return oauthError(400, 'invalid_grant', 'PKCE verification failed.');
            }
        }
        usedCodes.add(p.jti);
        setTimeout(() => usedCodes.delete(p.jti), (CODE_TTL + 5) * 1000).unref?.();
        console.log(`[oauth] issued tokens to "${client.name}" (authorization_code)`);
        return res.json(issueTokens(client.id, p.scope, p.res));
    }
    if (b.grant_type === 'refresh_token') {
        let p;
        try {
            p = jsonwebtoken_1.default.verify(String(b.refresh_token || ''), JWT_SECRET, { algorithms: ['HS256'] });
        }
        catch {
            return oauthError(400, 'invalid_grant', 'Invalid or expired refresh token.');
        }
        if (p.type !== 'refresh' || p.cid !== client.id)
            return oauthError(400, 'invalid_grant', 'Refresh token was not issued to this client.');
        console.log(`[oauth] refreshed tokens for "${client.name}"`);
        return res.json(issueTokens(client.id, p.scope, p.aud));
    }
    return oauthError(400, 'unsupported_grant_type');
});
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
// Basic REST endpoints for ChatGPT Custom Actions
app.post('/api/tools/:toolName', express_1.default.json(), async (req, res) => {
    const { toolName } = req.params;
    const mcp = createServer();
    const tools = mcp._registeredTools;
    const tool = tools && tools[toolName];
    if (!tool) {
        return res.status(404).json({ error: `Tool ${toolName} not found` });
    }
    try {
        const result = await tool.handler(req.body, {});
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/openapi.json', (req, res) => {
    const schema = {
        openapi: "3.1.0",
        info: { title: "CallRail API", version: "1.1.0" },
        servers: [{ url: `https://${req.get('host')}` }],
        components: {
            securitySchemes: {
                ApiKeyAuth: { type: "http", scheme: "bearer" }
            }
        },
        security: [{ ApiKeyAuth: [] }],
        paths: {
            "/api/tools/get_client_metrics": {
                post: {
                    summary: "Get client metrics",
                    operationId: "get_client_metrics",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, company_id: { type: "string" }, date_range: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/list_companies": {
                post: {
                    summary: "List companies",
                    operationId: "list_companies",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/list_accounts": {
                post: {
                    summary: "List accounts",
                    operationId: "list_accounts",
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/list_all_calls": {
                post: {
                    summary: "List all calls",
                    operationId: "list_all_calls",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, company_id: { type: "string" }, date_range: { type: "string" }, per_page: { type: "number" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/list_form_submissions": {
                post: {
                    summary: "List form submissions",
                    operationId: "list_form_submissions",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, company_id: { type: "string" }, date_range: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/get_marketing_data": {
                post: {
                    summary: "Get marketing data",
                    operationId: "get_marketing_data",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, date_range: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/get_call_details": {
                post: {
                    summary: "Get call details",
                    operationId: "get_call_details",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, call_id: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/update_call": {
                post: {
                    summary: "Update call",
                    operationId: "update_call",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, call_id: { type: "string" }, note: { type: "string" }, tags: { type: "array", items: { type: "string" } }, customer_name: { type: "string" }, lead_status: { type: "string" }, value: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            },
            "/api/tools/send_text_message": {
                post: {
                    summary: "Send text message",
                    operationId: "send_text_message",
                    requestBody: {
                        required: true,
                        content: { "application/json": { schema: { type: "object", properties: { account_id: { type: "string" }, company_id: { type: "string" }, customer_phone_number: { type: "string" }, tracking_number: { type: "string" }, content: { type: "string" } } } } }
                    },
                    responses: { "200": { description: "Success" } }
                }
            }
        }
    };
    res.json(schema);
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
