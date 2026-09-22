// MUST BE AT THE VERY TOP TO LOAD ENVIRONMENT VARIABLES FROM .env
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================
const CONFIG = {
    BASE_URL: (process.env.WA_API_BASE_URL || 'https://api.whatsapp.com/agent/v1').replace(/\/+$/, ''),
    TOKEN: (process.env.WA_BEARER_TOKEN || process.env.AGENT1_TOKEN || '').trim(),
    N8N_SALES_URL: process.env.AGENT1_N8N_URL || process.env.N8N_WEBHOOK_URL || '',
    N8N_SUPPORT_URL: process.env.AGENT2_N8N_URL || '',
    N8N_INQUIRIES_URL: process.env.AGENT3_N8N_URL || '',
    OFFSET_FILE: path.join(__dirname, process.env.OFFSET_FILE || 'offset.json'),
    POLL_TIMEOUT_SEC: 15,
    DELAY_MS: 1500
};

if (!CONFIG.TOKEN) {
    console.error('❌ Error: WA_BEARER_TOKEN is missing in .env');
    process.exit(1);
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// ============================================================
// OFFSET MANAGEMENT
// ============================================================
function loadOffset() {
    try {
        if (fs.existsSync(CONFIG.OFFSET_FILE)) {
            const parsed = JSON.parse(fs.readFileSync(CONFIG.OFFSET_FILE, 'utf8'));
            if (typeof parsed.offset === 'number') return parsed.offset;
        }
    } catch (err) {
        console.warn('⚠️ Could not read offset:', err.message);
    }
    return null;
}

function saveOffset(offset) {
    try {
        fs.writeFileSync(CONFIG.OFFSET_FILE, JSON.stringify({ offset }, null, 2), 'utf8');
    } catch (err) {
        console.error('❌ Failed to save offset:', err.message);
    }
}

// ============================================================
// MESSAGING API
// ============================================================
async function sendWhatsAppMessage(toUserId, body) {
    if (!toUserId || !body) return false;

    try {
        const response = await fetch(`${CONFIG.BASE_URL}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: toUserId,
                type: 'text',
                text: { body: String(body).substring(0, 4096) }
            }),
            signal: AbortSignal.timeout(25000)
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            console.error(`❌ Reply failed (${response.status}):`, data?.error?.message || response.statusText);
            return false;
        }

        const msgId = data?.messages?.[0]?.id || 'OK';
        console.log(`✓ Reply sent to ${toUserId} [ID: ${msgId}]`);
        return true;
    } catch (err) {
        console.error(`❌ Error sending to ${toUserId}:`, err.message);
        return false;
    }
}

function extractMessages(payload) {
    if (!payload) return [];
    if (payload.entry && Array.isArray(payload.entry)) {
        const list = [];
        for (const entry of payload.entry) {
            for (const change of entry.changes || []) {
                if (change.value?.messages) list.push(...change.value.messages);
            }
        }
        if (list.length > 0) return list;
    }
    if (Array.isArray(payload.messages)) return payload.messages;
    if (Array.isArray(payload.updates)) return payload.updates;
    if (Array.isArray(payload)) return payload;
    return [];
}

// Determine which n8n webhook URL to send to
function pickWebhookUrl(text) {
    const lower = text.toLowerCase();
    if (CONFIG.N8N_SUPPORT_URL && (lower.includes('support') || lower.includes('help') || lower.includes('issue'))) {
        return { target: 'Support', url: CONFIG.N8N_SUPPORT_URL };
    }
    if (CONFIG.N8N_INQUIRIES_URL && (lower.includes('inquiry') || lower.includes('price') || lower.includes('cost') || lower.includes('fee'))) {
        return { target: 'Inquiries', url: CONFIG.N8N_INQUIRIES_URL };
    }
    // Default to primary / sales webhook
    return { target: 'Sales', url: CONFIG.N8N_SALES_URL || CONFIG.N8N_SUPPORT_URL || CONFIG.N8N_INQUIRIES_URL };
}

async function handleMessage(msg) {
    const messageId = msg.id || msg.key?.id;
    const senderId = msg.from || msg.key?.remoteJid || msg.sender;
    const incomingText = msg.text?.body || msg.body || (typeof msg.message === 'string' ? msg.message : '');

    if (!senderId || !incomingText) return;

    const { target, url } = pickWebhookUrl(incomingText);
    console.log(`📩 Incoming from ${senderId}: "${incomingText}" ➔ Routed to [${target}]`);

    let replyText = '';
    if (url) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    routedTo: target,
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
                console.error(`❌ [${target}] n8n returned HTTP ${res.status}`);
            }
        } catch (err) {
            console.error(`⚠️ Failed to reach [${target}] n8n webhook:`, err.message);
        }
    }

    if (!replyText) {
        replyText = `Hello! You reached our service. You said: "${incomingText}"`;
    }

    await delay(CONFIG.DELAY_MS);
    await sendWhatsAppMessage(senderId, replyText);
}

// ============================================================
// SINGLE POLLING WORKER
// ============================================================
async function pollUpdates() {
    let currentOffset = loadOffset();
    console.log(`🚀 Unified Polling Worker Started. Offset: ${currentOffset ?? 'HEAD (Latest)'}`);

    while (true) {
        try {
            const params = new URLSearchParams();
            if (currentOffset !== null && currentOffset !== undefined) {
                params.append('offset', String(currentOffset));
            }
            params.append('timeout', String(CONFIG.POLL_TIMEOUT_SEC));

            const res = await fetch(`${CONFIG.BASE_URL}/updates?${params.toString()}`, {
                headers: {
                    'Authorization': `Bearer ${CONFIG.TOKEN}`,
                    'Content-Type': 'application/json'
                },
                signal: AbortSignal.timeout(25000)
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
                    console.warn(`⚠️ Conflict (409): Another process or container is holding the socket. Waiting 25s...`);
                    await delay(25000);
                } else if (res.status === 400) {
                    console.error(`❌ 400 Bad Request:`, data);
                    await delay(6000);
                } else {
                    console.error(`⚠️ HTTP ${res.status}:`, data);
                    await delay(4000);
                }
                continue;
            }

            const messages = extractMessages(data);
            for (const msg of messages) {
                await handleMessage(msg);
            }

            const nextOffset = data?.next_offset ?? data?.offset ?? data?.last_offset;
            if (nextOffset !== undefined && nextOffset !== null) {
                currentOffset = nextOffset;
                saveOffset(currentOffset);
            }

        } catch (err) {
            console.error('Loop error:', err.message);
            await delay(3000);
        }

        await delay(CONFIG.DELAY_MS);
    }
}

pollUpdates();
