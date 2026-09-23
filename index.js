// MUST BE AT THE VERY TOP TO LOAD ENVIRONMENT VARIABLES FROM .env
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// ============================================================
// WhatsApp Agent Platform API: https://api.whatsapp.com/agent/v1
// "The API token identifies the agent" and "an agent may only message
// its creator" -> each agent is its own bot, its own token, its own
// update sequence. One independent long-poll loop per agent.
//
// n8n integration: the uploaded "Facebook Leads" and "AI Lead Finder"
// workflows both read their trigger payload as
//   { text, senderId, messageId, timestamp, type, profile_name, request_id }
// (see each workflow's "Normalize WhatsApp Message" code node), and both
// send the FINAL reply to the user themselves, directly against the
// Agent Platform API using their own token. So this script's job per
// message is: mark it read, forward it in that exact shape, and get out
// of the way — it must NOT also send a text reply for those agents, or
// the user gets two answers.
// ============================================================

const CONFIG = {
    BASE_URL: (process.env.WA_API_BASE_URL || 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
    OFFSET_DIR: path.join(__dirname, 'offsets'),
    POLL_TIMEOUT_SEC: 15, // manual: 0-25, default 15
    POLL_LIMIT: 50,       // manual: max 100, default 50
    N8N_HANDOFF_TIMEOUT_MS: 10_000, // just confirms the handoff was accepted, not the full campaign run
};

fs.mkdirSync(CONFIG.OFFSET_DIR, { recursive: true });

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Each agent is a fully separate bot: its own token, its own n8n webhook.
const AGENT_DEFS = [
    {
        id: 'find_leads',
        name: 'AI Lead Finder',
        token: (process.env.AGENT1_TOKEN || '').trim(),
        n8nUrl: process.env.AGENT1_N8N_URL || process.env.N8N_WEBHOOK_URL || '',
        kind: 'lead_finder' // n8n owns the whole conversation, including replying
    },
    {
        id: 'facebook_leads',
        name: 'Facebook Leads Engine',
        token: (process.env.AGENT2_TOKEN || '').trim(),
        n8nUrl: process.env.AGENT2_N8N_URL || '',
        kind: 'lead_finder',
        // The n8n flow's "Send Instructions Message" node isn't wired to
        // anything, so a non-1/2 message currently gets silently dropped.
        // Handle the menu here instead: anything that isn't a valid "1" or
        // "2" selection (greetings, "menu", "hi", "hello", garbage, etc.)
        // gets the menu directly and is never forwarded to n8n.
        menu: {
            text: `Hi! Reply with:\n1 - Website Developer leads\n2 - AI Automation leads`,
            // Mirrors n8n's own "Parse Selection" code node exactly, so a
            // message that would route in n8n also routes here.
            isSelection(text) {
                const clean = (text || '').trim();
                const m = clean.match(/^[12]$/) || clean.match(/\b([12])\b/);
                const picked = m ? m[0].replace(/\D/g, '') : '';
                return picked === '1' || picked === '2';
            }
        }
    },
    {
        id: 'support',
        name: 'Customer Support',
        token: (process.env.AGENT3_TOKEN || '').trim(),
        n8nUrl: process.env.AGENT3_N8N_URL || '',
        kind: 'support' // workflow shape unknown — script sends the reply itself
    }
].filter(a => {
    if (!a.token) {
        console.warn(`⚠️  Skipping agent "${a.id}" — no token configured for it in .env`);
        return false;
    }
    if (!a.n8nUrl) {
        console.warn(`⚠️  Agent "${a.id}" has a token but no n8n webhook URL configured — it will run but can't hand off messages.`);
    }
    return true;
});

if (AGENT_DEFS.length === 0) {
    console.error('❌ Error: no agent has a token configured (AGENT1_TOKEN / AGENT2_TOKEN / AGENT3_TOKEN).');
    process.exit(1);
}

// ============================================================
// PER-AGENT RATE LIMITING
// Manual: 12/min for POST /messages and POST /statuses; 15/min for
// GET /updates. Limits are per agent, per method.
// ============================================================
class RateLimiter {
    constructor(max, windowMs) {
        this.max = max;
        this.windowMs = windowMs;
        this.timestamps = [];
    }
    async wait() {
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
        if (this.timestamps.length >= this.max) {
            const waitMs = this.windowMs - (now - this.timestamps[0]) + 50;
            await delay(Math.max(waitMs, 50));
            return this.wait();
        }
        this.timestamps.push(Date.now());
    }
}

function attachRuntimeState(agent) {
    agent.offsetFile = path.join(CONFIG.OFFSET_DIR, `${agent.id}.json`);
    agent.sendLimiter = new RateLimiter(12, 60_000);
    agent.statusLimiter = new RateLimiter(12, 60_000);
    agent.pollLimiter = new RateLimiter(15, 60_000);
    return agent;
}
AGENT_DEFS.forEach(attachRuntimeState);

// ============================================================
// OFFSET PERSISTENCE (one file per agent)
// ============================================================
function loadOffset(agent) {
    try {
        if (fs.existsSync(agent.offsetFile)) {
            const parsed = JSON.parse(fs.readFileSync(agent.offsetFile, 'utf8'));
            if (typeof parsed.offset === 'number') return parsed.offset;
        }
    } catch {}
    return null; // null => first poll omits offset, starts at "head" (only new traffic)
}

function saveOffset(agent, offset) {
    try {
        fs.writeFileSync(agent.offsetFile, JSON.stringify({ offset }, null, 2), 'utf8');
    } catch (err) {
        console.error(`[${agent.name}] Failed saving offset:`, err.message);
    }
}

// ============================================================
// LOW-LEVEL API CLIENT
// POST /messages, POST /statuses, GET /updates — with the retry/backoff
// rules from the "Errors" section of the manual.
// ============================================================
async function apiRequest(agent, method, urlPath, { query, body } = {}) {
    const url = new URL(`${CONFIG.BASE_URL}${urlPath}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));

    const res = await fetch(url, {
        method,
        headers: {
            'Authorization': `Bearer ${agent.token}`,
            'Content-Type': 'application/json'
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout((CONFIG.POLL_TIMEOUT_SEC + 10) * 1000)
    });

    let data = null;
    if (res.status !== 204) {
        const raw = await res.text();
        try { data = raw ? JSON.parse(raw) : null; } catch { data = { raw }; }
    }
    return { status: res.status, data };
}

/**
 * Send a text message. 429 and 503/131016 are retried after backoff;
 * other 4xx are not retried; 500/network errors are left ambiguous by
 * design (retrying could double-send) — logged, not retried.
 */
async function sendText(agent, toUserId, body) {
    const text = String(body ?? '').slice(0, 4096);
    if (!toUserId || !text) return { ok: false, reason: 'missing to/body' };

    const maxAttempts = 4;
    let attempt = 0;
    let backoff = 2000;

    while (attempt < maxAttempts) {
        attempt++;
        await agent.sendLimiter.wait();

        try {
            const { status, data } = await apiRequest(agent, 'POST', '/messages', {
                body: {
                    messaging_product: 'whatsapp',
                    to: toUserId, // "user:<id>" — pass through from message.from
                    type: 'text',
                    text: { body: text }
                }
            });

            if (status === 200) {
                const wamid = data?.messages?.[0]?.id;
                console.log(`[${agent.name}] ✓ Sent to ${toUserId} (${wamid})`);
                return { ok: true, id: wamid };
            }
            if (status === 429 || (status === 503 && data?.error?.code === 131016)) {
                console.warn(`[${agent.name}] ${status} on send, retrying in ${backoff}ms (attempt ${attempt}/${maxAttempts})`);
                await delay(backoff);
                backoff *= 2;
                continue;
            }
            if (status >= 500) {
                console.error(`[${agent.name}] ${status} on send — outcome unknown, NOT auto-retrying to avoid a duplicate send.`, data?.error);
                return { ok: false, reason: 'ambiguous_5xx', data };
            }
            console.error(`[${agent.name}] ${status} send rejected:`, data?.error);
            return { ok: false, reason: 'rejected', status, data };

        } catch (err) {
            console.error(`[${agent.name}] Send network error:`, err.message);
            return { ok: false, reason: 'network_error', error: err.message };
        }
    }
    return { ok: false, reason: 'max_attempts_exhausted' };
}

/** Mark an inbound message read, optionally showing a typing indicator. */
async function markReadAndType(agent, messageId, showTyping) {
    if (!messageId) return;
    const body = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        ...(showTyping ? { typing_indicator: { type: 'text' } } : {})
    };
    await agent.statusLimiter.wait();
    try {
        const { status } = await apiRequest(agent, 'POST', '/statuses', { body });
        if (status === 503) {
            await agent.statusLimiter.wait();
            await apiRequest(agent, 'POST', '/statuses', { body }); // one retry per manual guidance
        }
    } catch (err) {
        console.error(`[${agent.name}] statuses call failed:`, err.message);
    }
}

// ============================================================
// n8n HANDOFF
// Payload shape matches each workflow's "Normalize WhatsApp Message"
// code node: body.text, body.senderId (falls back to body.from), and
// body.messageId (falls back to body.message_id).
// ============================================================
async function forwardToN8n(agent, payload, timeoutMs) {
    if (!agent.n8nUrl) return { ok: false, reason: 'no_n8n_url' };
    try {
        const res = await fetch(agent.n8nUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs)
        });
        return { ok: res.ok, status: res.status };
    } catch (err) {
        return { ok: false, reason: 'network_error', error: err.message };
    }
}

// ============================================================
// MESSAGE HANDLING FOR ONE AGENT
// ============================================================
async function handleInboundMessage(agent, message, contactNames) {
    const senderId = message.from; // already "user:<id>"
    if (!senderId) return;
    if (message.type === 'reaction') return; // nothing to reply to

    const incomingText = message.type === 'text' ? (message.text?.body || '') : null;

    await markReadAndType(agent, message.id, true);

    if (incomingText === null) {
        await sendText(agent, senderId, `I can only process text messages right now — please describe your request in words.`);
        return;
    }
    if (!incomingText.trim()) {
        await sendText(agent, senderId, `Sorry, I didn't catch that — could you type your request?`);
        return;
    }

    const payload = {
        text: incomingText,
        senderId,                 // matches body.senderId in the Normalize node
        messageId: message.id,    // matches body.messageId
        timestamp: message.timestamp,
        type: message.type,
        profile_name: contactNames?.[senderId] || undefined,
        request_id: message.id
    };

    if (agent.kind === 'lead_finder') {
        // If this agent has a menu gate and the message isn't a valid
        // selection, answer with the menu ourselves and stop — there's
        // nothing for n8n to do yet, and its own fallback path is unwired.
        if (agent.menu && !agent.menu.isSelection(incomingText)) {
            await sendText(agent, senderId, agent.menu.text);
            return;
        }

        // The n8n flow owns the conversation (menu parsing / AI campaign
        // parsing / scraping) and sends the final reply itself. We only
        // confirm the handoff succeeded; on failure we tell the user
        // directly so they're not left hanging.
        const result = await forwardToN8n(agent, payload, CONFIG.N8N_HANDOFF_TIMEOUT_MS);
        if (!result.ok) {
            console.error(`[${agent.name}] n8n handoff failed:`, result);
            await sendText(agent, senderId, `Sorry, something went wrong on our end. Please try again shortly.`);
        } else {
            console.log(`[${agent.name}] ✓ Handed off "${incomingText}" from ${senderId} to n8n`);
        }
        return;
    }

    // 'support' kind: workflow shape not provided — expect a synchronous
    // {reply|text|output} response, falling back to a generic ack.
    let responseText = '';
    if (agent.n8nUrl) {
        try {
            const res = await fetch(agent.n8nUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15000)
            });
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                const result = Array.isArray(data) ? data[0] : data;
                responseText = result?.reply || result?.text || result?.output || '';
            }
        } catch (err) {
            console.error(`[${agent.name}] Support webhook error:`, err.message);
        }
    }
    if (!responseText) {
        responseText = `Hello! You are connected with *${agent.name}*. An agent will review your inquiry shortly.`;
    }
    await sendText(agent, senderId, responseText);
}

// ============================================================
// PER-AGENT LONG-POLL WORKER
// ============================================================
async function runAgentWorker(agent) {
    let offset = loadOffset(agent);
    console.log(`🚀 [${agent.name}] worker online. Starting offset: ${offset ?? 'HEAD (new traffic only)'}`);

    while (true) {
        try {
            await agent.pollLimiter.wait();

            const { status, data } = await apiRequest(agent, 'GET', '/updates', {
                query: {
                    offset: offset === null ? undefined : offset,
                    limit: CONFIG.POLL_LIMIT,
                    timeout: CONFIG.POLL_TIMEOUT_SEC
                }
            });

            if (status === 204) continue; // nothing arrived — re-poll with same offset

            if (status === 200) {
                const value = data?.entry?.[0]?.changes?.[0]?.value;
                const messages = value?.messages || [];
                const statuses = value?.statuses || [];

                // contacts[].profile.name isn't always present — accumulate
                // per-batch, keyed by wa_id, and pass along to n8n as profile_name.
                const contactNames = {};
                for (const c of value?.contacts || []) {
                    if (c.wa_id && c.profile?.name) contactNames[c.wa_id] = c.profile.name;
                }

                for (const s of statuses) {
                    console.log(`[${agent.name}] receipt: ${s.status} for ${s.id} by ${s.recipient_id}`);
                }
                for (const m of messages) {
                    try {
                        await handleInboundMessage(agent, m, contactNames);
                    } catch (err) {
                        console.error(`[${agent.name}] error handling message ${m.id}:`, err.message);
                    }
                }

                if (typeof data.next_offset === 'number') {
                    offset = data.next_offset;
                    saveOffset(agent, offset);
                }
                continue;
            }

            if (status === 409) {
                console.warn(`[${agent.name}] 409 — another poll for this agent overlapped. Backing off 5s.`);
                await delay(5000);
                continue;
            }
            if (status === 429 || status >= 500) {
                console.warn(`[${agent.name}] ${status} on poll — backing off 5s, reusing offset.`);
                await delay(5000);
                continue;
            }
            if (status === 401) {
                console.error(`[${agent.name}] 401 — token missing/malformed. Stopping this agent's worker.`);
                return;
            }
            if (status === 400 && data?.error?.code === 100) {
                console.error(`[${agent.name}] 400 — token present but invalid. Regenerate it and restart. Stopping this agent's worker.`);
                return;
            }

            console.error(`[${agent.name}] Unexpected ${status} on poll:`, data);
            await delay(3000);

        } catch (err) {
            console.error(`[${agent.name}] Polling error:`, err.message);
            await delay(3000);
        }
    }
}

// ============================================================
// START ALL CONFIGURED AGENTS CONCURRENTLY
// ============================================================
async function main() {
    console.log(`Starting ${AGENT_DEFS.length} agent worker(s): ${AGENT_DEFS.map(a => a.name).join(', ')}`);
    await Promise.all(AGENT_DEFS.map(agent => runAgentWorker(agent)));
    console.error('All agent workers have stopped.');
}

main();
