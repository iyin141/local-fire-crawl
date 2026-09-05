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
struggle tonight. Buy **rotating residential**, not static/dedicated — trawl
already does its own sticky-per-domain proxy pinning
(`trawl/tiers/utils/proxyRotator.ts`'s `ProxyPool`, with round-robin across
domains and a 5-minute cooldown on failure), so a single static IP would
just hand it a pool of one, losing the fault-isolation the code already
does for you.

Fill in the three placeholders already scaffolded in `.env`:

```
PROXY_SERVER=          # + PROXY_USERNAME / PROXY_PASSWORD if issued separately
                        # covers the api container's fetch/pdf/document/image engines
RESIDENTIAL_PROXY_URL= # covers camoufox-service's Tier 4 escalation (Playwright's own proxy option)
# TIER3_PROXY_URL=     # optional: also route Tier 3's challenge-solving browser through it,
                        # at the cost of more proxy bandwidth per request
```

These are three separate mechanisms (a Node HTTP dispatcher, a Playwright
browser launch option, and — if the mapping service ever deploys alongside
this — Python's own `HTTP_PROXY`/`HTTPS_PROXY` convention) covering disjoint
code paths; setting one doesn't cover the others, and none conflict.

Then:

```bash
docker compose up -d camoufox-service api   # restart just these two to pick up the new env
```

Re-run the vfdgroup check from §4 — that's the confirmation the proxy is
actually taking effect, not just configured.
