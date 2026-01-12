## tmdb-proxy

这是一个利用Vercel代理tmdb接口的仓库。

完全免费，但是每月有100GB流量限制，自用的话是完全够用的。


## 部署
[![Vercel](https://vercel.com/button)](https://vercel.com/import/project?template=https://github.com/imaliang/tmdb-proxy)


## 使用方法

1. 部署。部署有两种方法：
    + 一是直接点击上方按钮一键部署。
    + 二是先fork本项目，再登录 [Vercel](https://vercel.com/) 选择自己的仓库新建。


2. 绑定自己的域名(必须，因为自带的域名vercel.app在国内基本不可用) 
    + 如果你没有域名，可以去 [腾讯云活动域名](https://curl.qcloud.com/ScJY3Hev) 注册一个，新用户1元1年。

3. 你自己绑定的域名就是tmdb的代理域名，会代理 api.themoviedb.org 和 image.tmdb.org

## Docker 部署

本项目也支持作为一个普通 Node 服务用 Docker 部署（同时代理 API 与图片）。

### 运行

```bash
docker build -t tmdb-proxy .
docker run --rm -p 3000:3000 tmdb-proxy
```

使用 GHCR 镜像（需要先把 `compose.yaml` 里的镜像地址改成你自己的）：

```bash
docker compose -f compose.yaml up -d
```

### Traefik：仅对 API 启用 gzip（图片不压缩）

仓库内提供了可直接运行的示例：`compose.traefik.yaml`。

```bash
docker compose -f compose.traefik.yaml up -d
```

验收（示例，按需替换为你能访问的 API/图片路径，且请求需要你自己的 TMDB 凭证）：

```bash
# API：应出现 Content-Encoding: gzip（建议选一个响应体 > 1400 bytes 的 API）
curl -H 'Accept-Encoding: gzip' -I 'http://localhost/3/configuration?api_key=<YOUR_TMDB_API_KEY>'

# 图片：不应出现 Content-Encoding: gzip
curl -H 'Accept-Encoding: gzip' -I 'http://localhost/t/p/w300/<path>.jpg'

# 如 -I 看不到 Content-Encoding，可用 GET 仅抓 header：
curl -H 'Accept-Encoding: gzip' -sS -D- -o /dev/null 'http://localhost/3/configuration?api_key=<YOUR_TMDB_API_KEY>'
```

回滚：

- 删除 `compose.traefik.yaml` 中 `tmdb-proxy-api.middlewares=tmdb-proxy-compress@docker` 标签，然后 `docker compose -f compose.traefik.yaml up -d` 重建即可。

### 示例

API（需要你自己的 TMDB 凭证，二选一）：

```bash
curl -H 'Authorization: Bearer <YOUR_TMDB_TOKEN>' 'http://localhost:3000/3/configuration'
# 或：curl 'http://localhost:3000/3/configuration?api_key=<YOUR_TMDB_API_KEY>'
```

图片：

```bash
curl -I 'http://localhost:3000/t/p/original/xxxx.jpg'
```

### 环境变量

- `PORT`：监听端口（默认 3000）
- `TMDB_API_BASE_URL`：TMDB API 上游（默认 `https://api.themoviedb.org`）
- `TMDB_IMAGE_BASE_URL`：TMDB 图片上游（默认 `https://image.tmdb.org`）
- `UPSTREAM_KEEP_ALIVE`：是否启用上游 keep-alive（默认 `false`）
- `CACHE_DURATION_MS`：API GET 缓存 TTL（默认 600000）
- `CACHE_MISS_SINGLEFLIGHT`：是否合并同一 cacheKey 的并发 cache miss（默认 `false`）
- `MAX_CACHE_SIZE`：最大缓存条目数（默认 1000）
- `MAX_CACHE_BODY_BYTES`：单条缓存最大响应体（默认 1048576）
- `ACCESS_LOG_SAMPLE_RATE`：访问日志采样率（`0..1`，默认 `1`；仅对 <400 的 `request.end` 生效，4xx/5xx/aborted 仍全量记录）

### 日志与排障

- 容器日志会输出 JSON 行日志（`request.end`/`request.aborted`/`config`），包含 `request_id`、`path`（会对 `api_key` 脱敏）、上游状态/耗时、缓存命中信息等。
- 每个响应会带 `X-Request-Id`，方便把客户端请求和后端日志关联起来。
- 如果请求里的 `api_key` 带有零宽字符/空白字符，会自动清理，并在日志里标记 `api_key_sanitized=true`。

## GitHub Actions 自动构建镜像

仓库内已添加工作流（`.github/workflows/docker.yml`），推送到 `main/master` 或打 tag（`v*`）时会构建并推送到 GHCR：

```bash
docker pull ghcr.io/<owner>/<repo>:latest
```

## 感谢

[本项目 CDN 加速及安全防护由 Tencent EdgeOne 赞助](https://edgeone.ai/zh?from=github)

<a href="https://edgeone.ai/zh?from=github">
  <img src="https://edgeone.ai/media/34fe3a45-492d-4ea4-ae5d-ea1087ca7b4b.png" width="400" alt="Tencent EdgeOne">
</a>
