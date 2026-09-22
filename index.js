require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OFFSET_FILE = path.join(__dirname, process.env.OFFSET_FILE || 'offset.json');
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ============================================================
// AGENT REGISTRY
// ============================================================
// Dynamically build active agents that have configured tokens
const AGENTS = [
    {
        id: 'agent_1',
        name: process.env.AGENT1_NAME || 'Agent 1',
        baseUrl: (process.env.AGENT1_BASE_URL || process.env.WA_API_BASE_URL || 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
        token: process.env.AGENT1_TOKEN || process.env.WA_BEARER_TOKEN,
        n8nUrl: process.env.AGENT1_N8N_URL || process.env.N8N_WEBHOOK_URL
    },
    {
        id: 'agent_2',
        name: process.env.AGENT2_NAME || 'Agent 2',
        baseUrl: (process.env.AGENT2_BASE_URL || 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
        token: process.env.AGENT2_TOKEN,
        n8nUrl: process.env.AGENT2_N8N_URL
    },
    {
        id: 'agent_3',
        name: process.env.AGENT3_NAME || 'Agent 3',
        baseUrl: (process.env.AGENT3_BASE_URL || 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
        token: process.env.AGENT3_TOKEN,
        n8nUrl: process.env.AGENT3_N8N_URL
    }
].filter(agent => Boolean(agent.token)); // Run only agents with configured tokens

if (AGENTS.length === 0) {
    console.error('❌ No active agents configured. Check your .env file.');
    process.exit(1);
}

// ============================================================
// OFFSET MANAGEMENT (PER-AGENT ISOLATION)
// ============================================================
function loadOffset(agentId) {
    try {
        if (fs.existsSync(OFFSET_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8'));
            return parsed[agentId] ?? null;
        }
    } catch (err) {
        console.warn(`[${agentId}] Warning reading offset:`, err.message);
    }
    return null;
}

function saveOffset(agentId, offset) {
    try {
        let store = {};
        if (fs.existsSync(OFFSET_FILE)) {
            try { store = JSON.parse(fs.readFileSync(OFFSET_FILE, 'utf8')); } catch { store = {}; }
        }
        store[agentId] = offset;
        fs.writeFileSync(OFFSET_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        console.error(`[${agentId}] Failed to save offset:`, err.message);
    }
}

// ============================================================
// MESSAGING ENGINE
// ============================================================
async function sendWhatsAppMessage(agent, toUserId, body) {
    if (!toUserId || !body) return false;

    const url = `${agent.baseUrl}/messages`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${agent.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: toUserId,
                type: 'text',
                text: { body: String(body).substring(0, 4096) }
            }),
            signal: AbortSignal.timeout(20000)
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error(`[${agent.name}] ❌ Reply failed (${response.status}):`, data?.error?.message || response.statusText);
            return false;
        }

        const msgId = data?.messages?.[0]?.id || 'OK';
        console.log(`[${agent.name}] ✓ Reply dispatched to ${toUserId} [ID: ${msgId}]`);
        return true;
    } catch (err) {
        console.error(`[${agent.name}] ❌ Network error sending to ${toUserId}:`, err.message);
        return false;
    }
}

async function markRead(agent, messageId) {
    if (!messageId) return;
    try {
        await fetch(`${agent.baseUrl}/statuses`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${agent.token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId,
                typing_indicator: { type: 'text' }
            }),
            signal: AbortSignal.timeout(10000)
        });
    } catch {
        // Status tracking is optional on some bridges
    }
}

function extractMessages(payload) {
    if (!payload) return [];
    if (payload.entry && Array.isArray(payload.entry)) {
        const list = [];
        for (const entry of payload.entry) {
            for (const change of entry.changes || []) {
                if (change.value?.messages) {
                    list.push(...change.value.messages);
                }
            }
        }
        if (list.length > 0) return list;
    }
    if (Array.isArray(payload.messages)) return payload.messages;
    if (Array.isArray(payload.updates)) return payload.updates;
    if (Array.isArray(payload)) return payload;
    return [];
}

async function handleMessage(agent, msg) {
    const messageId = msg.id || msg.key?.id;
    const senderId = msg.from || msg.key?.remoteJid || msg.sender;
    const incomingText = msg.text?.body || msg.body || (typeof msg.message === 'string' ? msg.message : '');

    if (!senderId || !incomingText) return;

    console.log(`[${agent.name}] 📩 Incoming from ${senderId}: "${incomingText}"`);

    await markRead(agent, messageId);

    // Forward to that agent's specific n8n webhook
    let replyText = '';
    if (agent.n8nUrl) {
        try {
            const res = await fetch(agent.n8nUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    agentId: agent.id,
                    agentName: agent.name,
                    messageId,
                    senderId,
                    text: incomingText,
                    timestamp: msg.timestamp || Date.now()
                }),
                signal: AbortSignal.timeout(15000)
            });

            if (res.ok) {
                const n8nData = await res.json().catch(() => ({}));
                const result = Array.isArray(n8nData) ? n8nData[0] : n8nData;
                replyText = result?.reply || result?.summary || result?.text || result?.output || '';
            } else {
                console.error(`[${agent.name}] ❌ n8n returned ${res.status}`);
            }
        } catch (err) {
            console.error(`[${agent.name}] ⚠️ Could not reach n8n URL:`, err.message);
        }
    }

    if (!replyText) {
        replyText = `Hello! You reached ${agent.name}. You said: "${incomingText}"`;
    }

    await delay(1200);
    await sendWhatsAppMessage(agent, senderId, replyText);
}

// ============================================================
// AGENT WORKER POLLING LOOP
// ============================================================
async function runAgentWorker(agent) {
    let currentOffset = loadOffset(agent.id);
    console.log(`🚀 [${agent.name}] Worker started. Offset: ${currentOffset ?? 'HEAD (Latest)'}`);

    while (true) {
        try {
            const params = new URLSearchParams();
            if (currentOffset !== null && currentOffset !== undefined) {
                params.append('offset', String(currentOffset));
            }
            params.append('timeout', '15');

            const res = await fetch(`${agent.baseUrl}/updates?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${agent.token}`,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(22000)
            });

            if (res.status === 204) {
                await delay(1000);
                continue;
            }

            const rawText = await res.text();
            let data = null;
            try { data = JSON.parse(rawText); } catch { data = { raw: rawText }; }

            if (!res.ok) {
                if (res.status === 409) {
                    console.warn(`[${agent.name}] ⚠️ Conflict (409): Another instance running. Waiting 15s...`);
                    await delay(15000);
                } else if (res.status === 400) {
                    console.error(`[${agent.name}] ❌ 400 Bad Request:`, data);
                    await delay(6000);
                } else {
                    console.error(`[${agent.name}] ⚠️ HTTP ${res.status}:`, data);
                    await delay(4000);
                }
                continue;
            }

            const messages = extractMessages(data);
            for (const msg of messages) {
                await handleMessage(agent, msg);
            }

            // Update isolated offset for this specific agent
            const nextOffset = data?.next_offset ?? data?.offset ?? data?.last_offset;
            if (nextOffset !== undefined && nextOffset !== null) {
                currentOffset = nextOffset;
                saveOffset(agent.id, currentOffset);
            }

        } catch (err) {
            console.error(`[${agent.name}] Loop error:`, err.message);
            await delay(3000);
        }

        await delay(2500);
    }
}

// ============================================================
// CONCURRENT BOOTSTRAP
// ============================================================
console.log(`Starting ${AGENTS.length} isolated WhatsApp agent workers concurrently...`);
AGENTS.forEach(agent => {
    runAgentWorker(agent);
});
