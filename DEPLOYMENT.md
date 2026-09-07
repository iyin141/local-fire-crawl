# Deploying this fork to a fresh VM

This is a maintained local fork of Firecrawl — `playwright-service` (stock
Chromium) replaced with `camoufox-service` (Camoufox + trawl's tiered
WAF/challenge escalation), plus several local-only anti-bot fixes on top.
Source: `https://github.com/iyin141/local-fire-crawl` (`main`). The upstream
`firecrawl/firecrawl` project is not this repo's origin here — don't try to
push fixes there; they're fork-specific.

Current deployment target: an Oracle Linux VM, datacenter IP for now, a
residential proxy pending (see §5). Only this repo is being deployed —
nothing else in the wider project depends on that timing.

## 1. VM prep (Oracle Linux)

```bash
sudo dnf update -y
sudo dnf install -y dnf-utils git
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # log out/in, or `newgrp docker`, for this to take effect
```

Oracle Cloud has two firewall layers — the VCN Security List/NSG (console
side) and the OS-level `firewalld`. If nothing outside the VM needs to reach
`:3002` directly, leave both closed. Only open it if some other client will
call this Firecrawl instance from off-box.

**Sizing**: locally, `api` was capped at 8GB and `camoufox-service` at 4GB
RAM, alongside FoundationDB/Postgres/Redis/RabbitMQ. Give the VM at least
16GB RAM / 4+ vCPUs — going lower risks the same resource starvation this
fork hit locally under WSL during development.

## 2. Get the code onto the VM

```bash
git clone https://github.com/iyin141/local-fire-crawl.git firecrawl
cd firecrawl
```

`.env` is gitignored and was never pushed — copy it over separately
(`scp` from the dev machine, or recreate it — see §4 for what it needs).

## 3. Build and bring up

```bash
docker compose build   # needs GITHUB_TOKEN in .env for camoufox-js's build-time GitHub API calls
docker compose up -d
```

**Known quirk**: RabbitMQ's health check can fire before its ~20s startup
finishes, failing the first `up -d` with "dependency rabbitmq failed to
start." Not a real failure — just run `docker compose up -d` again once
RabbitMQ settles.

## 4. Verify

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3002/   # expect 200
docker ps   # all 6 containers should show Up

# a plain non-WAF site, to confirm the stack itself works:
curl -s -X POST http://localhost:3002/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://frcnigeria.gov.ng","formats":["markdown"],"timeout":60000}'

# a WAF/Cloudflare site, to see today's honest baseline on a datacenter IP:
curl -s -X POST http://localhost:3002/v2/scrape -H 'Content-Type: application/json' \
  -d '{"url":"https://vfdgroup.com","formats":["markdown"],"timeout":120000}'
```

The second call will likely fail or run long tonight — expected until the
proxy lands (§5), not a broken deployment. The first succeeding is what
actually confirms the infra is sound.

## 5. When the residential proxy arrives

Oracle Cloud's outbound IP ranges are known-datacenter and score higher-risk
with most WAFs (Cloudflare, Imperva, Akamai) regardless of Camoufox's
fingerprint quality — that's why the Cloudflare check above is expected to
struggle without one.

**Buy static/dedicated residential, not a rotating gateway.** An earlier
version of this doc said the opposite; a live 159-source rescan on 2026-09-07
settled it against rotating:

- A rotating gateway assigns a **fresh exit node per connection**, and a
  single `/v2/map` call opens several (homepage, robots.txt, sitemap.xml,
  sitemap_index.xml). Each one is an independent gamble on an unknown node.
- Measured on that run: **45 `Proxy response (502) !== 200 when HTTP
  Tunneling` failures and 34 `Sitemap fetch aborted`** in one log. Sources
  collapsed to their shallow homepage fallback — marketforcesafrica
  22,002 → 26 links, pencom 958 → 0.
- Switching to sticky sessions fixed those two specific sources (verified
  3/3), but a second full rescan regressed again under sustained load,
  because 5 sticky sessions were serving 159 domains — roughly 32 domains
  per residential device.

Static IPs remove both problems: no per-connection reassignment, and a pool
big enough that no single device carries the whole workload. Trawl's own
`ProxyPool` (`trawl/tiers/utils/proxyRotator.ts`) then does round-robin,
sticky-per-domain pinning, and a 5-minute cooldown across whatever list you
give it.

Fill in the placeholders scaffolded in `.env` — **both list vars take a
comma-separated list**, so paste every IP into each:

```
# api container's fetch/pdf/document/image engines (this includes /v2/map's
# own sitemap fetch, which is why a single value here throttled the rescan)
PROXY_SERVER=http://u:p@ip1:80,http://u:p@ip2:80,...
PROXY_USERNAME=      # optional shared fallback if creds aren't embedded per-URL
PROXY_PASSWORD=

# camoufox-service's Tier 4 escalation (Playwright's own proxy option)
RESIDENTIAL_PROXY_URL=http://u:p@ip1:80,http://u:p@ip2:80,...

# optional: also route Tier 3's challenge-solving browser through the pool,
# at the cost of more proxy bandwidth per request
# TIER3_PROXY_URL=
```

These are separate mechanisms covering disjoint code paths (a Node HTTP
dispatcher, a Playwright browser launch option, and — if the mapping service
ever deploys alongside this — Python's own `HTTP_PROXY`/`HTTPS_PROXY`
convention). Setting one does not cover the others, and none conflict.

### Optional: voluntary sticky handoff

Sticky-per-domain pins one IP to one site until that IP *fails*. Over weeks
that permanence is its own tell — real residential IPs churn (mobile carriers
reassign on every data toggle, home broadband on lease renewal). Two optional
vars add a scheduled handoff on top:

```
PROXY_DOMAIN_QUANTUM_MINUTES=   # hold a (domain, proxy) pairing this long, then hand off
PROXY_DOMAIN_REST_MINUTES=      # keep that domain off that proxy for this long afterwards
```

Both **default to off** — unset means the original "sticky until failure"
behaviour, which is what keeps a local run with no proxy at all unaffected.
Only meaningful with a multi-IP pool; with one proxy there is nothing to hand
off to.

Then:

```bash
docker compose up -d camoufox-service api   # restart just these two to pick up the new env
```

Re-run the vfdgroup check from §4 — but **under sustained load, not three
isolated calls**. Three passing calls is exactly what preceded the second
rescan regressing; concentration only shows up at volume.
