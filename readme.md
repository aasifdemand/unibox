# Unibox Backend Architecture

Unibox uses a **High-Scale Distributed Architecture** powered by RabbitMQ. Most tasks (Sending, Syncing, Warmup) are decoupled from the main API into specialized workers that can be scaled horizontally.

## Core Application
- **Main API**: `npm run dev` (Local) / `npm run start` (Production)
  - Handles HTTPS requests, OAuth flows, and Dashboard analytics.

---

## 🛠 Distributed Workers
You can run multiple instances of any worker across different servers to increase throughput.

### 📧 Campaign Scaling
- **Scheduler**: Identifies lead emails due for sending.
```bash
npm run scheduler
```
- **Orchestrator**: Manages campaign flow and transitions.
```bash
npm run orchestrator
```
- **Router**: Decides the best sender for maximum deliverability.
```bash
npm run router
```
- **Sender**: Performs the actual SMTP or API send.
```bash
npm run sender
```
- **Verifier**: Validates lead emails before sending.
```bash
npm run verifier
```

### 🔄 Mailbox & Inbox Management
- **Mailbox Sync**: Distributed synchronization of inbox data.
```bash
npm run mailbox
```
- **IMAP Append**: Synchronizes sent folder via IMAP.
```bash
npm run imap-append
```
- **Reply Ingestion**: Monitors replies and updates campaign stats.
```bash
npm run replier
```

### 🔥 Email Warmup System (Distributed)
- **Warmup Producer**: Identifies daily warmup eligibility.
```bash
npm run warmup
```
- **Warmup Monitor**: Rescues emails from Spam.
```bash
npm run warmup-monitor
```
- **Warmup Processor**: Generates AI content and executes tasks.
```bash
npm run warmup-processor
```

### 🔍 Analytics & Infrastructure
- **Elasticsearch Sync**: Syncs DB to ES for fast searching.
```bash
npm run es-sync
```
- **Blacklist Monitor**: Checks IP/Domain reputations globally.
```bash
npm run blacklist
```

---

## 🚀 Scaling Strategy
All workers use a **Distributed Leasing Architecture** (SQL `SKIP LOCKED`). 
To scale any part of the system, simply run additional instances via PM2:

```bash
# Example: Scale sending capacity to 4 instances
pm2 scale sender 4

# Example: Scale sync capacity to 4 instances
pm2 scale mailbox 4
```

