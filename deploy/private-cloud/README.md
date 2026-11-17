# Lemma Pro — Private Cloud (VPC) Deployment

This directory contains deployment assets for running the lemma Pro tier inside a customer's VPC/private cloud.

## Assets

- `Dockerfile` — container image build (per LEM-135 container conventions). Build from repo root:
  - `docker build -f deploy/private-cloud/Dockerfile -t lemma-private-cloud:<version> .`
- `docker-compose.yml` — Compose deployment (VPC-local volumes, documented outbound controls).
- `helm/lemma-private-cloud/` — Helm chart (Deployment/Service/PVC, values for outbound controls).
- `config.schema.json` — deployment/configuration schema (`lemma.deploy.private_cloud_config/v1`).
- `README.md` — this document (configuration, data flows, upgrade path).

## Configuration schema and Pro-tier settings (LEM-197)

- Deployment configuration conforms to `deploy/private-cloud/config.schema.json`.
- **Tunnels/proxies for pre-production pages are configured via the Pro-tier settings schema (LEM-197)** (steered plan/settings context, e.g. `.lemma/pro/plan.json` `context.private_cloud` / `context.tunnels_proxies` or equivalent Pro settings) and validated by Pro runtime.
- Unsafe tunnel/proxy targets are rejected per **LEM-059** (SSRF/target validation: non-public, loopback, link-local, metadata, blocked/reserved ranges, invalid schemes/hosts are refused).

## Data flows (VPC boundary) — documented and disable-able

**Default posture:** all state, evidence, and reports remain inside the VPC.

| Outbound traffic | Purpose | Default | How to disable |
| --- | --- | --- | --- |
| (a) Licence validation | Validate Pro entitlement/licence with configured licence service | Enabled (configurable) | Set `LEMMA_LICENSE_VALIDATION=disabled` (Compose/env), `licenseValidation.enabled=false` (Helm), or `data_flow.license_validation_outbound.enabled=false` in config |
| (b) Explicitly configured tunnels/proxies | Reach pre-production pages/endpoints through customer-approved tunnel/proxy targets only | Disabled | Set `LEMMA_TUNNELS_PROXIES=disabled` (Compose/env), `tunnelsProxies.enabled=false` (Helm), or `data_flow.tunnels_proxies_outbound.enabled=false` in config; omit tunnel/proxy entries |

- No other outbound traffic is required or performed by default. Network/firewall policy in the VPC should restrict egress to only the explicitly enabled, documented endpoints.
- Tunnel/proxy targets must be explicitly configured, validated, and can be individually disabled. Unsafe targets are rejected (LEM-059).

## Advanced auth/header handling (custom header injection with redaction)

- Custom headers can be injected for advanced auth/proxy scenarios via private-cloud config or Pro-tier settings (LEM-197), e.g. `custom_headers` / per-tunnel `headers`.
- **Redaction:** sensitive header names/values (e.g. `Authorization`, cookies, tokens, API keys, secrets) are redacted before persistence, logs, or report/state emission. Only redacted representations may be stored; raw secret values must not be written to `.lemma/`, evidence, or logs.
- Configuration should prefer secret references/injection at runtime; avoid embedding raw credentials in committed config files.

## Upgrade path (documented)

1. **Prepare:** review release notes and schema changes; back up `.lemma/` state/evidence volumes (inside VPC) and export required reports.
2. **Validate config:** ensure `deploy/private-cloud/config.schema.json` compatibility and Pro-tier settings (LEM-197) validity; revalidate tunnels/proxies (LEM-059).
3. **Build/pull image:** build per LEM-135 conventions (`docker build -f deploy/private-cloud/Dockerfile ...`) or pull the approved private-cloud image tag.
4. **Roll out:** 
   - Compose: `docker compose -f deploy/private-cloud/docker-compose.yml pull/build && up -d` (or staged recreate) with the same state volume.
   - Helm: `helm upgrade --install lemma-private-cloud deploy/private-cloud/helm/lemma-private-cloud -f values.yaml` (bump image tag, keep PVC).
5. **Verify:** run deployment dry-run/health checks, confirm data-flow controls (licence validation/tunnels-proxies enablement), and validate reports/evidence accessibility.
6. **Rollback:** redeploy previous image tag/chart version against the preserved `.lemma/` volume if needed (state remains in-VPC).

Schema/config changes follow additive, versioned evolution; breaking changes require a version bump and migration notes.
