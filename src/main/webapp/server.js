const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const WEBAPP_DIR = __dirname;

// Minimal .env loader (no external dependencies)
function loadEnv() {
    const candidates = [path.join(WEBAPP_DIR, '.env'), path.join(WEBAPP_DIR, '..', '..', '..', '.env')];
    for (const file of candidates) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return;
                const eq = trimmed.indexOf('=');
                if (eq === -1) return;
                const key = trimmed.substring(0, eq).trim();
                let val = trimmed.substring(eq + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                if (key && process.env[key] === undefined) process.env[key] = val;
            });
        } catch(e) { /* file not found, ignore */ }
    }
}
loadEnv();

function parseGeminiKeys() {
    const multi = process.env.GEMINI_API_KEYS;
    if (multi) return multi.split(',').map(k => k.trim()).filter(Boolean);
    if (process.env.GEMINI_API_KEY) return [process.env.GEMINI_API_KEY.trim()];
    return [];
}

const GEMINI_API_KEYS = parseGeminiKeys();
let keyIndex = 0;
function getNextKey(overrideKey) {
    if (overrideKey) return overrideKey;
    const key = GEMINI_API_KEYS[keyIndex % GEMINI_API_KEYS.length];
    keyIndex++;
    console.log(`  Using API key #${keyIndex} (${key.substring(0, 15)}...)`);
    return key;
}
function envInt(name, def) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) ? v : def;
}
function envNum(name, def) {
    const v = parseFloat(process.env[name]);
    return Number.isFinite(v) ? v : def;
}

// All tunables are env-driven (see .env.example). Client-visible values are
// exposed via GET /api/config; secrets are never included there.
const CFG = {
    geminiBase: process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    openaiUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
    anthropicUrl: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1/messages',

    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3-coder-128k:latest',

    temperature: envNum('AI_TEMPERATURE', 0.3),
    maxTokens: envInt('AI_MAX_TOKENS', 16384),
    geminiMaxTokens: envInt('GEMINI_MAX_TOKENS', 65536),
    anthropicMaxTokens: envInt('ANTHROPIC_MAX_TOKENS', 8192),

    geminiRetries: envInt('GEMINI_RETRIES', 3),
    geminiRetryDelayMs: envInt('GEMINI_RETRY_DELAY_MS', 3000),
    geminiTimeoutMs: envInt('GEMINI_TIMEOUT_MS', 180000),
    ollamaTimeoutMs: envInt('OLLAMA_TIMEOUT_MS', 300000),
    requestTimeoutMs: envInt('AI_TIMEOUT_MS', 180000),

    ollamaNumCtx: envInt('OLLAMA_NUM_CTX', 32768),
    ollamaNumPredict: envInt('OLLAMA_NUM_PREDICT', 16384),
    ollamaRepeatPenalty: envNum('OLLAMA_REPEAT_PENALTY', 1.1)
};

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.gif': 'image/gif'
};

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

function proxyGemini(model, payload, overrideKey) {
    return new Promise(async (resolve, reject) => {
        if (!overrideKey && GEMINI_API_KEYS.length === 0) {
            reject(new Error('No Gemini API key. Set GEMINI_API_KEY in .env or enter one in Settings.'));
            return;
        }
        const useModel = model || CFG.geminiModel;
        const maxRetries = CFG.geminiRetries;
        let lastError = null;
        for (let retry = 0; retry < maxRetries; retry++) {
            const keyCount = overrideKey ? 1 : GEMINI_API_KEYS.length;
            for (let i = 0; i < keyCount; i++) {
                const apiKey = getNextKey(overrideKey);
                const url = new URL(`${CFG.geminiBase}/v1beta/models/${useModel}:generateContent?key=${apiKey}`);
                const data = JSON.stringify(payload);
                try {
                    const result = await new Promise((res, rej) => {
                        const options = {
                            hostname: url.hostname,
                            path: url.pathname + url.search,
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
                        };
                        const proxyReq = https.request(options, r => {
                            let body = '';
                            r.on('data', chunk => body += chunk);
                            r.on('end', () => {
                                try { res(JSON.parse(body)); }
                                catch(e) { rej(new Error('Invalid response from Gemini')); }
                            });
                        });
                        proxyReq.on('error', rej);
                        proxyReq.setTimeout(CFG.geminiTimeoutMs, () => { proxyReq.destroy(); rej(new Error('Gemini timeout')); });
                        proxyReq.write(data);
                        proxyReq.end();
                    });
                    if (result.error && result.error.code === 429) {
                        console.log(`  Key #${keyIndex} rate limited, trying next...`);
                        lastError = 'Rate limited';
                        continue;
                    }
                    if (result.error && (result.error.code === 503 || result.error.message?.includes('high demand'))) {
                        console.log(`  Key #${keyIndex} high demand, retry #${retry + 1} in ${CFG.geminiRetryDelayMs}ms...`);
                        lastError = 'High demand';
                        await new Promise(r => setTimeout(r, CFG.geminiRetryDelayMs));
                        break;
                    }
                    if (result.error) {
                        console.log(`  Key #${keyIndex} error: ${result.error.message}`);
                        lastError = result.error.message;
                        continue;
                    }
                    return resolve(result);
                } catch(e) {
                    console.log(`  Key #${keyIndex} failed: ${e.message}`);
                    lastError = e.message;
                    continue;
                }
            }
        }
        reject(new Error(lastError || 'All API keys failed'));
    });
}

function proxyOllama(url, model, prompt) {
    return new Promise((resolve, reject) => {
        const baseUrl = process.env.OLLAMA_URL || url || CFG.ollamaUrl;
        const useModel = model || CFG.ollamaModel;
        const ollamaUrl = new URL(baseUrl.replace(/\/+$/, '') + '/api/generate');
        const data = JSON.stringify({
            model: useModel,
            prompt,
            stream: false,
            options: {
                temperature: CFG.temperature,
                num_predict: CFG.ollamaNumPredict,
                num_ctx: CFG.ollamaNumCtx,
                repeat_penalty: CFG.ollamaRepeatPenalty
            }
        });
        const options = {
            hostname: ollamaUrl.hostname,
            port: ollamaUrl.port || 11434,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        };
        const proxyReq = http.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch(e) { reject(new Error('Invalid response from Ollama')); }
            });
        });
        proxyReq.on('error', reject);
        proxyReq.setTimeout(CFG.ollamaTimeoutMs, () => { proxyReq.destroy(); reject(new Error('Ollama timeout - try a smaller model')); });
        proxyReq.write(data);
        proxyReq.end();
    });
}

function proxyCustomEndpoint(endpoint, apiKey, model, prompt) {
    return new Promise((resolve, reject) => {
        const url = new URL(endpoint);
        const payload = JSON.stringify({
            model: model || CFG.openaiModel,
            messages: [{ role: 'user', content: prompt }],
            temperature: CFG.temperature,
            max_tokens: CFG.maxTokens
        });
        const isHttps = url.protocol === 'https:';
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + apiKey,
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const proto = isHttps ? https : http;
        const proxyReq = proto.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch(e) { reject(new Error('Invalid response from endpoint')); }
            });
        });
        proxyReq.on('error', reject);
        proxyReq.setTimeout(CFG.requestTimeoutMs, () => { proxyReq.destroy(); reject(new Error('Endpoint timeout')); });
        proxyReq.write(payload);
        proxyReq.end();
    });
}

function postJson(targetUrl, headers, payloadObj, timeoutMsg) {
    return new Promise((resolve, reject) => {
        const url = new URL(targetUrl);
        const payload = JSON.stringify(payloadObj);
        const isHttps = url.protocol === 'https:';
        const options = {
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname + url.search,
            method: 'POST',
            headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, headers)
        };
        const proto = isHttps ? https : http;
        const req = proto.request(options, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(body)); }
                catch(e) { reject(new Error('Invalid JSON response from ' + url.hostname)); }
            });
        });
        req.on('error', reject);
        req.setTimeout(CFG.requestTimeoutMs, () => { req.destroy(); reject(new Error(timeoutMsg || 'Request timeout')); });
        req.write(payload);
        req.end();
    });
}

function proxyOpenAI(apiKey, model, prompt) {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) return Promise.reject(new Error('No OpenAI API key. Set OPENAI_API_KEY in .env or enter one in Settings.'));
    return postJson(CFG.openaiUrl, { 'Authorization': 'Bearer ' + key }, {
        model: model || CFG.openaiModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: CFG.temperature,
        max_tokens: CFG.maxTokens
    }, 'OpenAI timeout');
}

function proxyAnthropic(apiKey, model, prompt) {
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) return Promise.reject(new Error('No Anthropic API key. Set ANTHROPIC_API_KEY in .env or enter one in Settings.'));
    return postJson(CFG.anthropicUrl, {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
    }, {
        model: model || CFG.anthropicModel,
        max_tokens: CFG.anthropicMaxTokens,
        messages: [{ role: 'user', content: prompt }]
    }, 'Anthropic timeout');
}

const server = http.createServer(async (req, res) => {
    const startTime = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // API proxy routes
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/config') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ollamaUrl: CFG.ollamaUrl,
            geminiModel: CFG.geminiModel,
            openaiModel: CFG.openaiModel,
            anthropicModel: CFG.anthropicModel,
            ollamaModel: CFG.ollamaModel,
            temperature: CFG.temperature,
            geminiMaxTokens: CFG.geminiMaxTokens,
            providers: {
                gemini: GEMINI_API_KEYS.length > 0,
                openai: !!process.env.OPENAI_API_KEY,
                anthropic: !!process.env.ANTHROPIC_API_KEY,
                ollama: true
            }
        }));
        return;
    }

    if (req.method === 'POST' && req.url === '/api/gemini') {
        try {
            const body = JSON.parse(await readBody(req));
            console.log(`  -> Gemini API call (${body?.model || 'unknown'})...`);
            const result = await proxyGemini(body.model, body.payload, body.apiKey);
            console.log(`  <- Gemini OK (${Date.now() - startTime}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            console.log(`  <- Gemini ERROR: ${e.message} (${Date.now() - startTime}ms)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/ollama') {
        try {
            const body = JSON.parse(await readBody(req));
            console.log(`  -> Ollama API call (${body?.model || 'unknown'})...`);
            const result = await proxyOllama(body.url, body.model, body.prompt);
            console.log(`  <- Ollama OK (${Date.now() - startTime}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            console.log(`  <- Ollama ERROR: ${e.message} (${Date.now() - startTime}ms)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/openai') {
        try {
            const body = JSON.parse(await readBody(req));
            console.log(`  -> OpenAI API call (${body?.model || 'unknown'})...`);
            const result = await proxyOpenAI(body.apiKey, body.model, body.prompt);
            if (result.error) throw new Error(result.error.message || 'OpenAI error');
            console.log(`  <- OpenAI OK (${Date.now() - startTime}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            console.log(`  <- OpenAI ERROR: ${e.message} (${Date.now() - startTime}ms)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/anthropic') {
        try {
            const body = JSON.parse(await readBody(req));
            console.log(`  -> Anthropic API call (${body?.model || 'unknown'})...`);
            const result = await proxyAnthropic(body.apiKey, body.model, body.prompt);
            if (result.error) throw new Error(result.error.message || 'Anthropic error');
            console.log(`  <- Anthropic OK (${Date.now() - startTime}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            console.log(`  <- Anthropic ERROR: ${e.message} (${Date.now() - startTime}ms)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    if (req.method === 'POST' && req.url === '/api/custom') {
        try {
            const body = JSON.parse(await readBody(req));
            console.log(`  -> Custom endpoint call (${body?.model || 'unknown'} -> ${body?.endpoint || 'none'})...`);
            const result = await proxyCustomEndpoint(body.endpoint, body.apiKey, body.model, body.prompt);
            console.log(`  <- Custom OK (${Date.now() - startTime}ms)`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
        } catch(e) {
            console.log(`  <- Custom ERROR: ${e.message} (${Date.now() - startTime}ms)`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Static file serving (strip query string and hash; map "/" to index.html)
    let pathname = req.url.split('?')[0].split('#')[0];
    try { pathname = decodeURIComponent(pathname); } catch(e) { /* keep raw */ }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    let filePath = path.join(WEBAPP_DIR, pathname);

    if (!filePath.startsWith(WEBAPP_DIR)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    const nets = require('os').networkInterfaces();
    let ip = 'localhost';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) { ip = net.address; break; }
        }
    }
    console.log(`KareTum Diagram server running:`);
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  Network: http://${ip}:${PORT}`);
    console.log(`  Providers configured:`);
    console.log(`    Gemini:    ${GEMINI_API_KEYS.length ? GEMINI_API_KEYS.length + ' key(s)' : 'no key (enter in Settings)'}`);
    console.log(`    OpenAI:    ${process.env.OPENAI_API_KEY ? 'yes' : 'no key (enter in Settings)'}`);
    console.log(`    Anthropic: ${process.env.ANTHROPIC_API_KEY ? 'yes' : 'no key (enter in Settings)'}`);
    console.log(`    Ollama:    ${CFG.ollamaUrl}`);
    console.log(`  Models:`);
    console.log(`    Gemini:    ${CFG.geminiModel}`);
    console.log(`    OpenAI:    ${CFG.openaiModel}`);
    console.log(`    Anthropic: ${CFG.anthropicModel}`);
    console.log(`    Ollama:    ${CFG.ollamaModel}`);
});
