# Overview — What Microservice Mapper Is

## What It Does

Microservice Mapper is a **zero-instrumentation observability platform** for Docker-based microservice stacks. It discovers your topology, monitors your services in real time, and visualizes everything in an interactive 2D/3D UI — without a single line of code added to your applications.

You point it at an EC2 instance, give it an SSH key, and it does the rest:

- Reads your Docker Compose file over SSH to build a declared architecture baseline
- Monitors running containers via the Docker socket for health and metrics
- Parses container access logs for HTTP request/response data
- Polls `/proc/net/tcp` to observe active TCP connections
- Builds a live graph combining declared + observed state
- Runs unsupervised anomaly detection (optional Python sidecar)
- Performs evidence-based root cause analysis when services degrade

## What It Is NOT

| Common assumption | Reality |
|---|---|
| "Like Zipkin/Jaeger" | No. There are no distributed trace spans. "Traces" here means SSH-sampled TCP snapshots. |
| "Like Datadog/New Relic" | No. No agent installed in your app. No bytecode instrumentation. |
| "Like Prometheus + Grafana" | No. No metrics push. No PromQL. No scrape config. |
| "Like Kubernetes dashboard" | No. Targets are Docker Compose stacks on plain EC2, not Kubernetes. |
| "Real-time per-request data" | Partial. Log-parsed HTTP events are near-real-time; TCP observations are sampled at 5s intervals. |

## Design Philosophy

The core insight that drives every design decision:

> **Declared architecture + runtime observation = the truth about your system.**

Most tools show you either what *should* be happening (architecture diagrams) or what *is* happening right now (metrics). Microservice Mapper shows both simultaneously and highlights the delta — which is where all the interesting information lives.

### What the delta tells you

| Observed | Declared | Meaning |
|---|---|---|
| ✅ | ✅ | Expected dependency, confirmed at runtime |
| ❌ | ✅ | Dead code or misconfiguration — nobody is calling this service |
| ✅ | ❌ | Shadow dependency — undocumented inter-service communication |

## Origin

Started as a visualization tool for two target systems:

1. **Sock Shop** — Weave Works' open-source e-commerce microservice demo
2. **Vertikal** — A custom financial trading simulation platform

The architecture is adapter-aware so both can share the same graph engine despite having different log formats, different gateway types (Traefik vs NGINX), and different service topologies.

## Scale & Resource Philosophy

> "Do NOT build an unnecessarily heavy telemetry system." — original design brief

The system is designed to run the backend on a developer laptop and the collector on a `t2.micro` EC2 instance. This means:
- No Kafka, no Cassandra, no InfluxDB
- No agent process inside containers
- Configurable polling intervals (default 5s)
- In-memory state with JSON-on-disk persistence
- ~1 hour metric history (ring buffer, not a time-series DB)
