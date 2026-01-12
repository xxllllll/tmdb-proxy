# tmdb-proxy Docker 部署与性能调查报告

## 1. 背景与目标

本项目最初面向 Vercel 部署（`vercel.json:1`），当前已扩展为可 Docker 部署并通过 GitHub Actions 自动构建 GHCR 镜像（`.github/workflows/docker.yml:1`）。本文基于当前代码与运行日志，对稳定性问题与性能优化空间做一次复核与建议整理，并给出 Traefik 前置压缩的落地方式。

## 2. 当前实现概览（代码层）

**对外服务入口**

- Node HTTP Server：`server.js:1` 启动 `createTmdbProxyHandler()` 并监听 `PORT`（默认 3000）。

**代理路由**

- 图片：`/t/p/...` 走图片代理（流式转发）：`src/tmdbProxy.js:231`、`src/tmdbProxy.js:153`
- API：其余路径走 TMDB API 代理：`src/tmdbProxy.js:267`

**缓存策略（仅 API GET）**

- 仅缓存 `GET` 且非图片路径：`src/tmdbProxy.js:157`
- 缓存 key：`pathname + search` + `Authorization`（hash）+ `Accept-Language`：`src/tmdbProxy.js:115`
- TTL：`CACHE_DURATION_MS`（默认 10 分钟）：`src/tmdbProxy.js:7`、`src/tmdbProxy.js:188`
- 最大条目数：`MAX_CACHE_SIZE`（默认 1000）：`src/tmdbProxy.js:8`、`src/tmdbProxy.js:189`
- 单条缓存大小上限：`MAX_CACHE_BODY_BYTES`（默认 1 MiB）：`src/tmdbProxy.js:9`、`src/tmdbProxy.js:190`

**安全与兼容**

- `api_key` 自动清理零宽字符/空白字符（解决复制粘贴污染）：`src/tmdbProxy.js:78`
- 上游请求头默认走 allowlist（避免把客户端杂项头转发到 TMDB 导致 403 或风控命中）：`src/tmdbProxy.js:22`、`src/tmdbProxy.js:130`
- 如确需透传所有头，可设置 `UPSTREAM_FORWARD_ALL_HEADERS=true`：`src/tmdbProxy.js:183`

**可观测性**

- 访问日志：JSON 行日志（`request.end` / `request.aborted`），附带 `request_id`、上游耗时、cache 状态等：`src/tmdbProxy.js:349`
- 响应头：`X-Request-Id` 方便串联客户端与服务端日志：`src/tmdbProxy.js:367`

## 3. 关键问题复盘（与日志对应）

### 3.1 “隐形字符 api_key”导致请求异常

现象：客户端在 querystring 里携带的 `api_key` 含零宽字符（Unicode `Cf` 类）/空白，导致中间层或上游拒绝请求。

处置：服务端在解析 URL 后对 `api_key` 做规范化清理，并在日志中标记 `api_key_sanitized=true`：`src/tmdbProxy.js:355`、`src/tmdbProxy.js:359`。

### 3.2 403（Forbidden）问题的真实来源

当日志出现：

- `proxy: "api"` + `upstream_host: "api.themoviedb.org"` + `upstream_status: 403`

说明 403 来自 TMDB 上游而不是本服务本地拒绝。当前代码会在 4xx/5xx 时尽量提取 TMDB 的 `status_code/status_message` 并写入日志，便于进一步定位：`src/tmdbProxy.js:308`。

同时，默认 allowlist 头转发能显著降低这类 403 的出现概率（实践上已验证）：`src/tmdbProxy.js:22`、`src/tmdbProxy.js:130`。

## 4. 性能现状与瓶颈判断

### 4.1 请求路径开销（粗分）

**API（JSON）**

- Cache hit：直接返回缓存对象并 `JSON.stringify` 输出（CPU 很轻，上游不耗时）：`src/tmdbProxy.js:278`
- Cache miss：请求 TMDB -> 拿到 JSON（axios 解析为对象）-> `JSON.stringify` 输出：`src/tmdbProxy.js:303`、`src/tmdbProxy.js:328`、`src/tmdbProxy.js:346`

**图片（流式）**

- 直接 `https.request` + `pipe`，基本不做数据加工：`src/tmdbProxy.js:236`

### 4.2 目前最主要的性能痛点

1. **上游网络与 TLS 建连成本**  
   目前上游请求未显式启用 keep-alive（API 使用 axios 默认 agent、图片使用 Node 默认 agent），高并发/密集请求下会放大握手与连接建立开销。

2. **API 响应未复用上游压缩**  
   API 路径使用 `sendJson()` 固定输出 JSON 文本（`Content-Encoding` 不会从上游透传）：`src/tmdbProxy.js:49`。在没有前置压缩的情况下，会明显增加带宽与延迟。

3. **Cache miss “并发风暴”**  
   同一个资源在短时间被多个客户端并发请求时，会对 TMDB 产生重复请求（目前没有 singleflight/inflight 合并）。

4. **缓存阈值导致的“热点大包不缓存”**  
   Emby 常见的 `append_to_response` 会显著增大响应体，超过 `MAX_CACHE_BODY_BYTES` 时不会缓存：`src/tmdbProxy.js:330`。这会让“热门大包”一直走上游，延迟与上游配额更敏感。

### 4.3 基线与验收口径（先量化再优化）

本节用于把“代表性请求集合 + 采样时间窗 + 指标口径 + 回滚开关”落盘，作为后续每一步优化的统一验收依据（先对齐口径，再做改动）。

#### 4.3.1 部署拓扑（记录模板）

请在实际环境把下列信息补齐（不要写入任何密钥）：

- 流量路径：Client → Traefik → tmdb-proxy → TMDB
- tmdb-proxy 副本数：`<replicas>`（例如 1 / 2 / 3）
- 是否走 Traefik gzip：`<on|off>`（见“回滚开关清单”）
- 采样时间窗：warmup `<30s>` + sample `<120s>`（建议每次变更都一致）

#### 4.3.2 代表性请求集合（API + 图片）

需要准备一个有效的 `api_key`，但**不要**把真实 `api_key` 写入仓库文档/日志；以下仅用占位符表示。

API（建议至少选 3 条：轻量/大包/带维度）：

- 轻量：`/3/configuration?api_key=<TMDB_API_KEY>`
- 大包（append）：`/3/tv/1399?api_key=<TMDB_API_KEY>&append_to_response=images,credits,aggregate_credits,external_ids,keywords,recommendations,similar,translations,videos`
- 带维度（至少其一）：`Authorization: Bearer <TOKEN>`、`Accept-Language: zh-CN`

图片（至少选 1–2 条）：

- `GET /t/p/w300/<path>.jpg`
- `GET /t/p/original/<path>.jpg`

#### 4.3.3 复现与压测命令（示例）

以下命令默认 tmdb-proxy 暴露在 `http://localhost:3000`（按需替换域名/端口）。建议每项优化前后都用同一组命令重复采样 2–3 次。

**curl（响应大小/请求头）**

- API 响应大小（bytes）：  
  `curl -sS -o /dev/null -w '%{size_download}\n' 'http://localhost:3000/3/configuration?api_key=<TMDB_API_KEY>'`
- API 基础可用性（输出响应头，便于观察 gzip 等）：  
  `curl -sS -D- -o /dev/null 'http://localhost:3000/3/configuration?api_key=<TMDB_API_KEY>'`
- 图片（仅看 header，不下载 body）：  
  `curl -sS -I 'http://localhost:3000/t/p/w300/<path>.jpg'`

**压测工具（延迟分位）**

- `wrk`（示例，关注 p50/p95/p99）：  
  `wrk -t4 -c64 -d120s --latency 'http://localhost:3000/3/configuration?api_key=<TMDB_API_KEY>'`
- `hey`（示例）：  
  `hey -c 64 -z 120s 'http://localhost:3000/3/configuration?api_key=<TMDB_API_KEY>'`

#### 4.3.4 指标口径与基线对比表

| 指标 | 采集方式（口径） | 基线 | 优化后 | 备注 |
|---|---|---:|---:|---|
| API 响应大小 | `curl size_download`（代表性 API 请求） | `<fill>` | `<fill>` | 可按“轻量/大包”分别记录 |
| API p50/p95/p99 | `wrk/hey` 输出（warmup 后 sample） | `<fill>` | `<fill>` | 固定并发/时长 |
| 上游 403 比例 | 解析日志 `upstream_status==403` | `<fill>` | `<fill>` | 采样窗口同压测 |
| 上游 5xx 比例 | 解析日志 `500<=upstream_status<600` | `<fill>` | `<fill>` | 同上 |
| Traefik CPU | `docker stats traefik`（采样窗口平均） | `<fill>` | `<fill>` | 开 gzip 会增 CPU |
| Node 内存 | `docker stats tmdb-proxy`（采样窗口平均） | `<fill>` | `<fill>` | 关注是否抖动/泄漏 |
| Node 句柄数 | `docker exec` 统计 `/proc/1/fd` | `<fill>` | `<fill>` | keep-alive 可能影响 |
| cache hit/miss | 解析日志 `cache` 字段（count/rate） | `<fill>` | `<fill>` | 仅 API GET 相关 |

日志快速统计（示例，取最近 5 分钟；按需替换容器名/时间窗）：

cache 命中分布：

```bash
docker logs tmdb-proxy --since 5m | python3 - <<'PY'
import collections
import json
import sys

counter = collections.Counter()
for line in sys.stdin:
    if not line.startswith("{"):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    counter[obj.get("cache", "unknown")] += 1
print(dict(counter))
PY
```

上游 403/5xx 比例（仅统计包含 `upstream_status` 的行）：

```bash
docker logs tmdb-proxy --since 5m | python3 - <<'PY'
import json
import sys

total = 0
status_403 = 0
status_5xx = 0
for line in sys.stdin:
    if not line.startswith("{"):
        continue
    try:
        obj = json.loads(line)
    except Exception:
        continue
    status = obj.get("upstream_status")
    if not isinstance(status, int):
        continue
    total += 1
    if status == 403:
        status_403 += 1
    if 500 <= status < 600:
        status_5xx += 1

def rate(count: int) -> float:
    return (count / total) if total else 0

print(
    {
        "total": total,
        "403": status_403,
        "5xx": status_5xx,
        "403_rate": rate(status_403),
        "5xx_rate": rate(status_5xx),
    }
)
PY
```

#### 4.3.5 回滚开关清单（后续每步都必须可单独关闭）

下列“开关命名/默认值”会作为后续优化实现的约束（避免改完无法回退）：

- Traefik API gzip（P0）：通过 Traefik `compress` middleware 控制（见第 6 节示例）。回滚：API router 移除 `middlewares=tmdb-compress@docker` 或删除 middleware。
- 上游 keep-alive（P1）：`UPSTREAM_KEEP_ALIVE=true|false`，默认值：`false`（回滚：设为 `false`）。
- cache miss singleflight（P1）：`CACHE_MISS_SINGLEFLIGHT=true|false`，默认值：`false`（回滚：设为 `false`）。
- 缓存阈值调参（P2）：`MAX_CACHE_BODY_BYTES`、`MAX_CACHE_SIZE`，默认值见代码常量（回滚：恢复默认 env）。
- 日志降噪/采样（P2）：`ACCESS_LOG_SAMPLE_RATE=<0..1>`，默认值：`1`（全量；回滚：设为 `1`；错误/4xx/5xx 仍需全量记录）。

## 5. 优化建议（结合 Traefik 压缩）

### 5.1 优先级 P0：在 Traefik 开启 gzip 压缩（API 路由）

你已经在前面有 Traefik，建议把 **gzip 压缩放在 Traefik 层**（避免在 Node 里引入额外 CPU/复杂度）。

Traefik `compress` 中间件行为（官方文档）：

- 响应体 > 1400 bytes
- 客户端请求头 `Accept-Encoding` 包含 gzip
- 响应没有 `Content-Encoding`（即未被上游压缩过）

参考：Traefik v2.2 Compress middleware  
https://doc.traefik.io/traefik/v2.2/middlewares/compress/

落地建议：

- **只对 API 路由启用 compress**；图片路由不启用（图片格式本身已压缩，gzip 收益低且增加 CPU）。
- 如果你目前只有一个 router 同时承载 `/t/p/*` 与 API，建议拆成两个 router：一个 `PathPrefix(`/t/p/`)`（无 compress），一个 Host 级别（启用 compress）。

### 5.2 优先级 P1：上游 keep-alive（应用层）

为 API 与图片上游添加 `https.Agent({ keepAlive: true })`（axios + https.request 共用），通常能显著降低密集请求场景的尾延迟（减少重复 TLS 握手/建连）。

这属于低风险、纯性能优化，兼容性好；但需要注意连接数与空闲连接回收策略（避免过高的 socket 占用）。

### 5.3 优先级 P1：Cache miss 合并（singleflight）

对 cacheable GET（`src/tmdbProxy.js:157`）按 `cacheKey` 做 inflight 合并：同一 key 的并发请求共享一次上游请求结果。

收益：

- 降低 TMDB 上游压力（配额/限流更稳）
- 降低 cache miss 场景下的平均延迟

### 5.4 优先级 P2：缓存阈值调参

如果你确认机器内存足够，可以：

- 提高 `MAX_CACHE_BODY_BYTES`（例如 2–5 MiB）
- 同时降低 `MAX_CACHE_SIZE`（避免最坏情况内存爆炸）

这能显著降低 Emby “大响应 + 高频”的上游请求比例。

推荐档位（先从保守开始，结合第 4.3 节的基线数据与容器内存水位再调整；所有变更都可通过 env 一键回滚）：

| 档位 | `MAX_CACHE_BODY_BYTES` | `MAX_CACHE_SIZE` | 适用场景 | 说明 |
|---|---:|---:|---|---|
| 保守（推荐起点） | 2097152（2 MiB） | 500 | 热点大包偶发超 1MiB | 更容易缓存 `append_to_response`，同时控制条目数避免最坏情况内存爆炸 |
| 激进（大包优先） | 5242880（5 MiB） | 200 | 大包接口占比高且内存充足 | 提升大包命中率，但单条对象占用更大，需重点观察 GC/内存水位 |

注意事项：

- `MAX_CACHE_BODY_BYTES` 的判定基于 `JSON.stringify` 的字节大小（近似口径）；实际对象驻留内存可能更高。
- 建议每次只改一个档位，并在同一请求集合/采样窗口下对比：cache store/hit、上游请求比例、容器内存与 GC。
- 回滚：删除/恢复上述 env（或恢复到默认值：`MAX_CACHE_BODY_BYTES=1048576`、`MAX_CACHE_SIZE=1000`）。

### 5.5 优先级 P2：日志降噪/采样

目前每个请求都会输出结构化日志（`src/tmdbProxy.js:349`）。在图片请求量很大的场景，日志 I/O 可能成为额外开销。可引入 `LOG_LEVEL`/采样策略，仅保留：

- 4xx/5xx
- API 路径
- 或抽样 N%

## 6. Traefik 配置示例（Docker labels）

下述示例用于“tmdb-proxy 容器通过 Traefik 暴露到域名”，并对 API 开启 gzip。label 语义参考：Traefik v2.2 Docker provider 文档  
https://doc.traefik.io/traefik/v2.2/routing/providers/docker/

示例（思路展示，需替换域名/entrypoints/证书配置）：

```yaml
services:
  tmdb-proxy:
    image: ghcr.io/xxllllll/tmdb-proxy:latest
    labels:
      - traefik.enable=true
      - traefik.http.services.tmdb-proxy.loadbalancer.server.port=3000

      - traefik.http.middlewares.tmdb-compress.compress=true

      - traefik.http.routers.tmdb-img.rule=Host(`tmdb.example.com`) && PathPrefix(`/t/p/`)
      - traefik.http.routers.tmdb-img.priority=100
      - traefik.http.routers.tmdb-img.service=tmdb-proxy

      - traefik.http.routers.tmdb-api.rule=Host(`tmdb.example.com`)
      - traefik.http.routers.tmdb-api.service=tmdb-proxy
      - traefik.http.routers.tmdb-api.middlewares=tmdb-compress@docker
```

说明：

- 用 `priority` 确保图片路由优先匹配，避免图片也走 compress。
- 若你使用 HTTPS，需要给两个 router 分别加上 `entrypoints`/`tls`/`tls.certresolver` 等标签。

## 7. 风险与权衡

- **开启 gzip（Traefik）**：增加 Traefik CPU，但通常带宽/延迟收益更大；图片建议不压缩。
- **增大缓存阈值**：降低上游压力但提高内存占用；需结合机器内存与访问模式调整。
- **多副本部署**：当前缓存是进程内 `Map`（`src/tmdbProxy.js:192`），多副本之间不共享；如需要跨副本缓存需引入外部缓存（复杂度上升）。

## 8. 建议的后续执行清单

1. Traefik：按第 6 节拆分 router，并仅对 API router 启用 `compress`。
2. 观察指标：对比开启 compress 前后（带宽、平均耗时、95/99 分位），并关注 Traefik CPU。
3. 应用层优化：实现上游 keep-alive + cache miss singleflight。
4. 缓存调参（按需）：根据访问模式调整 `MAX_CACHE_BODY_BYTES/MAX_CACHE_SIZE`。
