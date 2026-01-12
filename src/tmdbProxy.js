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

    function proxyImage(req, res, url) {
        const upstreamUrl = new URL(tmdbImageBaseUrl);

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
            console.error('TMDB image proxy error:', error);
            if (!res.headersSent) setCorsHeaders(res);
            sendJson(res, 502, { error: 'Bad Gateway', details: error.message });
        });

        req.pipe(upstreamReq);
    }

    async function proxyApi(req, res, url) {
        const upstreamUrl = new URL(tmdbApiBaseUrl);
        const requestPath = url.pathname + url.search;

        const cacheKey = buildCacheKey(url, req.headers);

        if (isCacheableRequest(req, url) && cache.has(cacheKey)) {
            const cachedData = cache.get(cacheKey);
            if (Date.now() < cachedData.expiry) {
                console.log('Cache hit:', redactUrlForLog(requestPath));
                setCorsHeaders(res);
                return sendJson(res, 200, cachedData.data);
            }
            cache.delete(cacheKey);
        }

        const upstreamHeaders = buildUpstreamHeaders(req, upstreamUrl.hostname);

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

        if (response.status === 200 && isCacheableRequest(req, url)) {
            const serialized = JSON.stringify(response.data);
            const sizeBytes = Buffer.byteLength(serialized);
            if (sizeBytes <= maxCacheBodyBytes) {
                checkCacheSize();
                cache.set(cacheKey, { data: response.data, expiry: Date.now() + cacheDurationMs });
                console.log('Cache miss and stored:', redactUrlForLog(requestPath));
            } else {
                console.log('Response not cached due to size:', sizeBytes);
            }
        }

        setCorsHeaders(res);
        copyUpstreamHeaders(res, response.headers);
        sendJson(res, response.status, response.data);
    }

    return async (req, res) => {
        setCorsHeaders(res);

        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
        }

        const url = new URL(req.url || '/', 'http://localhost');

        if (url.pathname === '/') {
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
                proxyImage(req, res, url);
                return;
            }

            await proxyApi(req, res, url);
        } catch (error) {
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
