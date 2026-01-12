const crypto = require('crypto');
const https = require('https');
const axios = require('axios');

const DEFAULT_TMDB_API_BASE_URL = 'https://api.themoviedb.org';
const DEFAULT_TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org';
const DEFAULT_CACHE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHE_SIZE = 1000;
const DEFAULT_MAX_CACHE_BODY_BYTES = 1024 * 1024;

const hopByHopHeaders = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJson(res, statusCode, body) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
}

function logLine(level, event, fields) {
    const payload = {
        time: new Date().toISOString(),
        level,
        event,
        ...fields
    };
    const writer = level === 'error' ? console.error : console.log;
    writer(JSON.stringify(payload));
}

function getHeaderValue(headers, name) {
    const value = headers?.[name];
    if (Array.isArray(value)) return value[0];
    return value;
}

function getRequestId(req) {
    const fromHeader = getHeaderValue(req.headers, 'x-request-id');
    if (typeof fromHeader === 'string' && fromHeader.trim()) return fromHeader.trim();
    return crypto.randomUUID();
}

function sanitizeApiKeyValue(value) {
    if (typeof value !== 'string') return value;
    return value.replace(/\p{Cf}/gu, '').replace(/\s+/gu, '');
}

function sanitizeUrlSearchParams(url) {
    const apiKeyValues = url.searchParams.getAll('api_key');
    if (apiKeyValues.length === 0) return { api_key_sanitized: false };

    const sanitizedValues = apiKeyValues.map(sanitizeApiKeyValue);
    const changed = sanitizedValues.some((next, index) => next !== apiKeyValues[index]);
    if (!changed) return { api_key_sanitized: false };

    url.searchParams.delete('api_key');
    for (const value of sanitizedValues) {
        url.searchParams.append('api_key', value);
    }

    return { api_key_sanitized: true };
}

function redactUrlForLog(rawUrl) {
    try {
        const url = new URL(rawUrl, 'http://localhost');
        if (url.searchParams.has('api_key')) {
            url.searchParams.set('api_key', 'REDACTED');
        }
        return url.pathname + (url.search || '');
    } catch {
        return rawUrl;
    }
}

function hashHeader(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function buildCacheKey(url, headers) {
    const auth = headers?.authorization;
    const acceptLanguage = headers?.['accept-language'];

    const parts = [url.pathname + url.search];
    if (auth) {
        parts.push(`auth=${hashHeader(auth)}`);
    }
    if (acceptLanguage) {
        parts.push(`lang=${acceptLanguage}`);
    }

    return parts.join('|');
}

function buildUpstreamHeaders(req, targetHost) {
    const upstreamHeaders = {};
    for (const [headerName, headerValue] of Object.entries(req.headers || {})) {
        const lower = headerName.toLowerCase();
        if (hopByHopHeaders.has(lower)) continue;
        if (lower === 'host') continue;
        if (headerValue === undefined) continue;
        upstreamHeaders[headerName] = headerValue;
    }

    upstreamHeaders.host = targetHost;
    return upstreamHeaders;
}

function isImagePath(pathname) {
    return pathname.startsWith('/t/p/');
}

function isCacheableRequest(req, url) {
    if (req.method !== 'GET') return false;
    if (isImagePath(url.pathname)) return false;
    return true;
}

function copyUpstreamHeaders(res, upstreamHeaders, options = {}) {
    const includeContentLength = options.includeContentLength === true;
    const includeContentEncoding = options.includeContentEncoding === true;

    for (const [headerName, headerValue] of Object.entries(upstreamHeaders || {})) {
        if (headerValue === undefined) continue;
        const lower = headerName.toLowerCase();
        if (hopByHopHeaders.has(lower)) continue;
        if (lower.startsWith('access-control-')) continue;
        if (!includeContentLength && lower === 'content-length') continue;
        if (!includeContentEncoding && lower === 'content-encoding') continue;
        res.setHeader(headerName, headerValue);
    }
}

function createTmdbProxyHandler(options = {}) {
    const tmdbApiBaseUrl = options.tmdbApiBaseUrl || process.env.TMDB_API_BASE_URL || DEFAULT_TMDB_API_BASE_URL;
    const tmdbImageBaseUrl =
        options.tmdbImageBaseUrl || process.env.TMDB_IMAGE_BASE_URL || DEFAULT_TMDB_IMAGE_BASE_URL;

    const cacheDurationMs = toPositiveInteger(process.env.CACHE_DURATION_MS, DEFAULT_CACHE_DURATION_MS);
    const maxCacheSize = toPositiveInteger(process.env.MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_SIZE);
    const maxCacheBodyBytes = toPositiveInteger(process.env.MAX_CACHE_BODY_BYTES, DEFAULT_MAX_CACHE_BODY_BYTES);

    const cache = new Map();

    try {
        logLine('info', 'config', {
            tmdb_api_origin: new URL(tmdbApiBaseUrl).origin,
            tmdb_image_origin: new URL(tmdbImageBaseUrl).origin,
            cache_duration_ms: cacheDurationMs,
            max_cache_size: maxCacheSize,
            max_cache_body_bytes: maxCacheBodyBytes
        });
    } catch {
        // ignore config log failures
    }

    function cleanExpiredCache() {
        const now = Date.now();
        for (const [key, value] of cache.entries()) {
            if (now > value.expiry) {
                cache.delete(key);
            }
        }
    }

    function checkCacheSize() {
        if (cache.size <= maxCacheSize) return;

        const entries = Array.from(cache.entries());
        entries.sort((a, b) => a[1].expiry - b[1].expiry);

        const deleteCount = cache.size - maxCacheSize;
        entries.slice(0, deleteCount).forEach(([key]) => cache.delete(key));

        console.log(`Cleaned ${deleteCount} old cache entries`);
    }

    const interval = setInterval(cleanExpiredCache, cacheDurationMs);
    interval.unref?.();

    function proxyImage(req, res, url, ctx) {
        const upstreamUrl = new URL(tmdbImageBaseUrl);
        ctx.proxy = 'image';
        ctx.upstream_host = upstreamUrl.hostname;

        const upstreamReq = https.request(
            {
                protocol: upstreamUrl.protocol,
                hostname: upstreamUrl.hostname,
                port: upstreamUrl.port || 443,
                method: req.method,
                path: url.pathname + url.search,
                headers: buildUpstreamHeaders(req, upstreamUrl.hostname)
            },
            (upstreamRes) => {
                ctx.upstream_status = upstreamRes.statusCode || 502;
                res.statusCode = upstreamRes.statusCode || 502;
                copyUpstreamHeaders(res, upstreamRes.headers, {
                    includeContentLength: true,
                    includeContentEncoding: true
                });
                setCorsHeaders(res);
                upstreamRes.pipe(res);
            }
        );

        upstreamReq.on('error', (error) => {
            ctx.error = error?.message || 'upstream_error';
            console.error('TMDB image proxy error:', error);
            if (!res.headersSent) setCorsHeaders(res);
            sendJson(res, 502, { error: 'Bad Gateway', details: error.message });
        });

        req.pipe(upstreamReq);
    }

    async function proxyApi(req, res, url, ctx) {
        const upstreamUrl = new URL(tmdbApiBaseUrl);
        const requestPath = url.pathname + url.search;
        ctx.proxy = 'api';
        ctx.upstream_host = upstreamUrl.hostname;

        const cacheKey = buildCacheKey(url, req.headers);

        const cacheable = isCacheableRequest(req, url);
        ctx.cache = cacheable ? 'miss' : 'bypass';

        if (cacheable && cache.has(cacheKey)) {
            const cachedData = cache.get(cacheKey);
            if (Date.now() < cachedData.expiry) {
                ctx.cache = 'hit';
                console.log('Cache hit:', redactUrlForLog(requestPath));
                setCorsHeaders(res);
                return sendJson(res, 200, cachedData.data);
            }
            cache.delete(cacheKey);
        }

        const upstreamHeaders = buildUpstreamHeaders(req, upstreamUrl.hostname);

        const upstreamStart = Date.now();
        const axiosConfig = {
            method: req.method,
            url: `${upstreamUrl.origin}${requestPath}`,
            headers: upstreamHeaders,
            validateStatus: () => true
        };

        if (!['GET', 'HEAD'].includes(req.method)) {
            axiosConfig.data = req;
        }

        const response = await axios.request(axiosConfig);
        ctx.upstream_status = response.status;
        ctx.upstream_duration_ms = Date.now() - upstreamStart;

        if (req.method === 'HEAD') {
            res.statusCode = response.status;
            setCorsHeaders(res);
            copyUpstreamHeaders(res, response.headers, {
                includeContentLength: true,
                includeContentEncoding: true
            });
            res.end();
            return;
        }

        if (response.status === 200 && cacheable) {
            const serialized = JSON.stringify(response.data);
            const sizeBytes = Buffer.byteLength(serialized);
            if (sizeBytes <= maxCacheBodyBytes) {
                checkCacheSize();
                cache.set(cacheKey, { data: response.data, expiry: Date.now() + cacheDurationMs });
                ctx.cache = 'store';
                console.log('Cache miss and stored:', redactUrlForLog(requestPath));
            } else {
                ctx.cache = 'skip_size';
                console.log('Response not cached due to size:', sizeBytes);
            }
        } else if (cacheable) {
            ctx.cache = 'skip_status';
        }

        setCorsHeaders(res);
        copyUpstreamHeaders(res, response.headers);
        sendJson(res, response.status, response.data);
    }

    return async (req, res) => {
        setCorsHeaders(res);

        const startTime = Date.now();
        const requestId = getRequestId(req);

        const url = new URL(req.url || '/', 'http://localhost');
        const sanitizeResult = sanitizeUrlSearchParams(url);
        const urlForLog = redactUrlForLog(url.pathname + url.search);

        const ctx = {
            request_id: requestId,
            method: req.method,
            path: urlForLog,
            has_auth: Boolean(req.headers?.authorization),
            ...sanitizeResult
        };

        res.setHeader('X-Request-Id', requestId);

        let accessLogged = false;
        const emitAccessLog = (event) => {
            if (accessLogged) return;
            accessLogged = true;
            logLine('info', event, {
                ...ctx,
                status: res.statusCode || 0,
                duration_ms: Date.now() - startTime
            });
        };

        res.on('finish', () => emitAccessLog('request.end'));
        res.on('close', () => {
            if (!accessLogged && !res.writableEnded) {
                ctx.aborted = true;
                emitAccessLog('request.aborted');
            }
        });

        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
        }

        if (url.pathname === '/') {
            ctx.proxy = 'health';
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(
                JSON.stringify({
                    name: 'tmdb-proxy',
                    status: 'ok'
                })
            );
            return;
        }

        try {
            if (isImagePath(url.pathname)) {
                proxyImage(req, res, url, ctx);
                return;
            }

            await proxyApi(req, res, url, ctx);
        } catch (error) {
            ctx.error = error?.message || 'proxy_error';
            console.error('TMDB proxy error:', error);
            const status = error.response?.status || 500;
            sendJson(res, status, {
                error: error.message,
                details: error.response?.data
            });
        }
    };
}

module.exports = { createTmdbProxyHandler };
