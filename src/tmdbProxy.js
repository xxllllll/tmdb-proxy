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

const allowedUpstreamHeaderNames = new Set([
    'accept',
    'accept-encoding',
    'accept-language',
    'authorization',
    'cache-control',
    'content-length',
    'content-type',
    'if-modified-since',
    'if-none-match',
    'if-range',
    'pragma',
    'range',
    'user-agent'
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

function buildUpstreamHeaders(req, targetHost, options = {}) {
    const forwardAllHeaders = options.forwardAllHeaders === true;
    const kind = options.kind === 'image' ? 'image' : 'api';
    const upstreamHeaders = {};
    for (const [headerName, headerValue] of Object.entries(req.headers || {})) {
        const lower = headerName.toLowerCase();
        if (hopByHopHeaders.has(lower)) continue;
        if (lower === 'host') continue;
        if (!forwardAllHeaders && !allowedUpstreamHeaderNames.has(lower)) continue;
        if (headerValue === undefined) continue;
        upstreamHeaders[headerName] = headerValue;
    }

    upstreamHeaders.host = targetHost;
    if (!upstreamHeaders['user-agent']) {
        upstreamHeaders['user-agent'] = 'tmdb-proxy/1.0';
    }
    if (kind === 'api' && !upstreamHeaders.accept) {
        upstreamHeaders.accept = 'application/json';
    }
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

    const forwardAllHeaders =
        typeof options.forwardAllHeaders === 'boolean'
            ? options.forwardAllHeaders
            : process.env.UPSTREAM_FORWARD_ALL_HEADERS === 'true';

    const upstreamKeepAlive =
        typeof options.upstreamKeepAlive === 'boolean'
            ? options.upstreamKeepAlive
            : process.env.UPSTREAM_KEEP_ALIVE === 'true';

    const upstreamHttpsAgent = upstreamKeepAlive ? new https.Agent({ keepAlive: true }) : undefined;

    const cacheDurationMs = toPositiveInteger(process.env.CACHE_DURATION_MS, DEFAULT_CACHE_DURATION_MS);
    const maxCacheSize = toPositiveInteger(process.env.MAX_CACHE_SIZE, DEFAULT_MAX_CACHE_SIZE);
    const maxCacheBodyBytes = toPositiveInteger(process.env.MAX_CACHE_BODY_BYTES, DEFAULT_MAX_CACHE_BODY_BYTES);

    const cache = new Map();
    const inflight = new Map();

    const cacheMissSingleflight =
        typeof options.cacheMissSingleflight === 'boolean'
            ? options.cacheMissSingleflight
            : process.env.CACHE_MISS_SINGLEFLIGHT === 'true';

    try {
        logLine('info', 'config', {
            tmdb_api_origin: new URL(tmdbApiBaseUrl).origin,
            tmdb_image_origin: new URL(tmdbImageBaseUrl).origin,
            upstream_forward_all_headers: forwardAllHeaders,
            upstream_keep_alive: upstreamKeepAlive,
            cache_miss_singleflight: cacheMissSingleflight,
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

        const upstreamRequestOptions = {
            protocol: upstreamUrl.protocol,
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || 443,
            method: req.method,
            path: url.pathname + url.search,
            headers: buildUpstreamHeaders(req, upstreamUrl.hostname, { forwardAllHeaders, kind: 'image' })
        };
        if (upstreamHttpsAgent) {
            upstreamRequestOptions.agent = upstreamHttpsAgent;
        }

        const upstreamReq = https.request(
            upstreamRequestOptions,
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

        const fetchFromUpstream = async () => {
            const upstreamHeaders = buildUpstreamHeaders(req, upstreamUrl.hostname, { forwardAllHeaders, kind: 'api' });

            const upstreamStart = Date.now();
            const axiosConfig = {
                method: req.method,
                url: `${upstreamUrl.origin}${requestPath}`,
                headers: upstreamHeaders,
                validateStatus: () => true
            };
            if (upstreamHttpsAgent) {
                axiosConfig.httpsAgent = upstreamHttpsAgent;
            }

            if (!['GET', 'HEAD'].includes(req.method)) {
                axiosConfig.data = req;
            }

            const response = await axios.request(axiosConfig);

            const shared = {
                status: response.status,
                headers: response.headers,
                data: response.data,
                upstream_duration_ms: Date.now() - upstreamStart,
                upstream_content_type: response.headers?.['content-type'],
                cache_result: cacheable ? 'skip_status' : 'bypass'
            };

            if (response.status >= 400) {
                if (response.data && typeof response.data === 'object') {
                    if (typeof response.data.status_code === 'number') shared.tmdb_status_code = response.data.status_code;
                    if (typeof response.data.status_message === 'string')
                        shared.tmdb_status_message = response.data.status_message;
                } else if (typeof response.data === 'string') {
                    shared.tmdb_status_message = response.data.slice(0, 200);
                }
            }

            if (response.status === 200 && cacheable) {
                const serialized = JSON.stringify(response.data);
                const sizeBytes = Buffer.byteLength(serialized);
                if (sizeBytes <= maxCacheBodyBytes) {
                    checkCacheSize();
                    cache.set(cacheKey, { data: response.data, expiry: Date.now() + cacheDurationMs });
                    shared.cache_result = 'store';
                    console.log('Cache miss and stored:', redactUrlForLog(requestPath));
                } else {
                    shared.cache_result = 'skip_size';
                    console.log('Response not cached due to size:', sizeBytes);
                }
            }

            return shared;
        };

        if (cacheable && cacheMissSingleflight) {
            const existing = inflight.get(cacheKey);
            if (existing) {
                ctx.singleflight = 'hit';
                const waitStart = Date.now();
                const shared = await existing;
                ctx.singleflight_wait_ms = Date.now() - waitStart;

                ctx.upstream_status = shared.status;
                ctx.upstream_duration_ms = shared.upstream_duration_ms;
                ctx.upstream_content_type = shared.upstream_content_type;
                if (typeof shared.tmdb_status_code === 'number') ctx.tmdb_status_code = shared.tmdb_status_code;
                if (typeof shared.tmdb_status_message === 'string') ctx.tmdb_status_message = shared.tmdb_status_message;

                if (shared.cache_result === 'store') {
                    ctx.cache = 'singleflight';
                } else {
                    ctx.cache = shared.cache_result;
                }

                setCorsHeaders(res);
                copyUpstreamHeaders(res, shared.headers);
                sendJson(res, shared.status, shared.data);
                return;
            }

            ctx.singleflight = 'miss';
            const promise = (async () => {
                try {
                    return await fetchFromUpstream();
                } finally {
                    inflight.delete(cacheKey);
                }
            })();
            inflight.set(cacheKey, promise);

            const shared = await promise;
            ctx.upstream_status = shared.status;
            ctx.upstream_duration_ms = shared.upstream_duration_ms;
            ctx.upstream_content_type = shared.upstream_content_type;
            if (typeof shared.tmdb_status_code === 'number') ctx.tmdb_status_code = shared.tmdb_status_code;
            if (typeof shared.tmdb_status_message === 'string') ctx.tmdb_status_message = shared.tmdb_status_message;
            ctx.cache = shared.cache_result;

            setCorsHeaders(res);
            copyUpstreamHeaders(res, shared.headers);
            sendJson(res, shared.status, shared.data);
            return;
        }

        const response = await fetchFromUpstream();
        ctx.upstream_status = response.status;
        ctx.upstream_duration_ms = response.upstream_duration_ms;
        ctx.upstream_content_type = response.upstream_content_type;
        if (typeof response.tmdb_status_code === 'number') ctx.tmdb_status_code = response.tmdb_status_code;
        if (typeof response.tmdb_status_message === 'string') ctx.tmdb_status_message = response.tmdb_status_message;

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

        if (cacheable) {
            ctx.cache = response.cache_result;
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
