// MUST BE AT THE VERY TOP TO LOAD ENVIRONMENT VARIABLES FROM .env
require('dotenv').config();

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION & STATE MANAGEMENT
// ============================================================

const CONFIG = {
    API_BASE_URL: process.env.WA_API_BASE_URL || 'https://api.whatsapp.com/agent/v1',
    BEARER_TOKEN: process.env.WA_BEARER_TOKEN,
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
    OFFSET_FILE: path.join(__dirname, process.env.OFFSET_FILE || 'offset.json'),
    POLL_INTERVAL_MS: 4500,
    RATE_LIMIT_DELAY_MS: 72000,
    POLL_TIMEOUT_SEC: 15
};

// Validate key presence immediately
if (!CONFIG.BEARER_TOKEN || CONFIG.BEARER_TOKEN === 'YOUR_AGENT_API_KEY') {
    console.error('❌ Error: WA_BEARER_TOKEN is missing or unconfigured in your .env file.');
    process.exit(1);
}

// ============================================================
// HELPER: CENTRAL API REQUEST WRAPPER
// ============================================================

async function apiRequest(endpoint, options = {}) {
    const url = `${CONFIG.API_BASE_URL}${endpoint}`;
    const controller = new AbortController();
    
    const timeoutMs = options.timeout || (CONFIG.POLL_TIMEOUT_SEC + 5) * 1000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
        'Authorization': `Bearer ${CONFIG.BEARER_TOKEN}`,
        ...options.headers
    };

    if (options.body && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }

    try {
        const response = await fetch(url, {
            ...options,
            headers,
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.status === 204) {
            return { statusCode: 204, data: null };
        }

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
            const err = new Error(`API Error ${response.status}: ${data?.error?.message || response.statusText}`);
            err.status = response.status;
            err.code = data?.error?.code;
            err.details = data?.error?.error_data?.details;
            err.fbtrace_id = data?.error?.fbtrace_id;
            throw err;
        }

        return { statusCode: response.status, data };
    } catch (error) {
        clearTimeout(timeout);
        throw error;
    }
}

// ============================================================
// OFFSET MANAGEMENT
// ============================================================

function loadOffset() {
    try {
        if (fs.existsSync(CONFIG.OFFSET_FILE)) {
            const fileData = fs.readFileSync(CONFIG.OFFSET_FILE, 'utf8');
            const parsed = JSON.parse(fileData);
            if (typeof parsed.offset === 'number') {
                return parsed.offset;
            }
        }
    } catch (error) {
        console.warn('⚠️ Could not read offset file:', error.message);
    }
    return null; 
}

function saveOffset(offset) {
    try {
        fs.writeFileSync(CONFIG.OFFSET_FILE, JSON.stringify({ offset }, null, 2), 'utf8');
    } catch (error) {
        console.error('❌ Failed to save offset:', error.message);
    }
}

// ============================================================
// MESSAGING & STATUS APIS
// ============================================================

async function markReadAndTyping(messageId, showTyping = false) {
    if (!messageId) return;

    const payload = {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
    };

    if (showTyping) {
        payload.typing_indicator = { type: 'text' };
    }

    try {
        await apiRequest('/statuses', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        console.log(`✓ Marked message ${messageId} as read ${showTyping ? '(typing...)' : ''}`);
    } catch (error) {
        console.error(`⚠️ Failed to set status on ${messageId}:`, error.message);
    }
}

async function sendText(toUserId, body) {
    if (!toUserId || !body) {
        console.error('❌ Missing participant ID or message body');
        return false;
    }

    try {
        const { data } = await apiRequest('/messages', {
            method: 'POST',
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: toUserId,
                type: 'text',
                text: {
                    body: String(body).substring(0, 4096)
                }
            }),
            timeout: 30000
        });

        const wamid = data?.messages?.[0]?.id;
        console.log(`✓ WhatsApp reply sent to ${toUserId} [WAMID: ${wamid}]`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to send message to ${toUserId}:`, error.message);
        if (error.details) console.error('Details:', error.details);
        return false;
    }
}

// ============================================================
// POLLING & MESSAGE PROCESSING ENGINE
// ============================================================

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function processUpdate(changeValue) {
    const messages = changeValue.messages || [];

    for (const message of messages) {
        const messageId = message.id;
        const senderId = message.from;

        console.log(`📩 Received message ${messageId} from ${senderId}`);

        // Step 1: Mark as read + trigger typing indicator
        await markReadAndTyping(messageId, true);
        await delay(CONFIG.RATE_LIMIT_DELAY_MS);

        // Step 2 & 3: Forward to n8n Webhook and send back n8n's reply
        if (message.type === 'text' && message.text?.body) {
            const incomingText = message.text.body;
            console.log(`   Content: "${incomingText}"`);

            let replyText = '';

            if (CONFIG.N8N_WEBHOOK_URL) {
                try {
                    const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ messageId, senderId, text: incomingText, timestamp: message.timestamp }),
                        signal: AbortSignal.timeout(10000) // don't hang if n8n is unreachable
                    });
                    if (!response.ok) {
                        const bodyText = await response.text().catch(() => '');
                        console.error(`❌ n8n webhook returned ${response.status}: ${bodyText.slice(0, 300)}`);
                    } else {
                        const n8nData = await response.json().catch(() => ({}));
                        const resultData = Array.isArray(n8nData) ? n8nData[0] : n8nData;
                        replyText = resultData?.reply || resultData?.summary || resultData?.text || '';
                    }
                } catch (err) {
                    console.error('❌ Failed to call n8n webhook:', err.message);
                }
            }

            // Fallback if n8n returns no text or fails
            if (!replyText) {
                replyText = `Hello! You said: "${incomingText}"`;
            }

            // Send actual dynamic reply to WhatsApp
            await sendText(senderId, replyText);
            await delay(CONFIG.RATE_LIMIT_DELAY_MS);
        }
    }
}


async function pollUpdates() {
    let currentOffset = loadOffset();
    console.log(`🚀 Agent Started. Current Offset: ${currentOffset ?? 'HEAD (New messages only)'}`);

    while (true) {
        try {
            const params = new URLSearchParams();
            if (currentOffset !== null) params.append('offset', currentOffset);
            params.append('timeout', CONFIG.POLL_TIMEOUT_SEC);
            params.append('limit', 50);

            const { statusCode, data } = await apiRequest(`/updates?${params.toString()}`, { method: 'GET' });

            if (statusCode === 204) {
                await delay(1000);
                continue;
            }

            if (data?.entry) {
                for (const entry of data.entry) {
                    for (const change of entry.changes || []) {
                        if (change.field === 'messages' && change.value) {
                            await processUpdate(change.value);
                        }
                    }
                }
            }

            if (data?.next_offset !== undefined) {
                currentOffset = data.next_offset;
                saveOffset(currentOffset);
            }

        } catch (error) {
            if (error.status === 429) {
                console.warn('⚠️ Rate limit hit (429). Backing off 10s...');
                await delay(10000);
            } else if (error.status === 409) {
                console.error('❌ Conflict (409): Another polling instance replaced this process.');
                process.exit(1);
            } else {
                console.error('⚠️ Update poll error:', error.message);
                await delay(5000);
            }
        }

        await delay(CONFIG.POLL_INTERVAL_MS);
    }
}

// Start Agent Polling Loop
pollUpdates();