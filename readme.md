# Hopper Tech Test

## Getting Started

Please refer to [coding-exercise.md](./coding-exercise.md) for the full problem description and instructions.

## Submitting your solution

Create your solution in a fork of this repository. Once you're ready to submit, please add dmanning-resilient as a collaborator on your private repository and send us a message.

## Candidate Notes

<!-- 
  Please update this section with details about your solution, including:
  - How to install dependencies and run your code (if applicable)
  - Any assumptions or trade-offs you made
  - Anything else you'd like the reviewer to know
-->
<br>

## Architecture Overview

The core challenge is meeting the sub-500ms acknowledgment SLA while performing slow external API calls (operator lookups) and database writes. The solution decouples receipt acknowledgment from processing using an async queue pattern.

```
Upstream System
      |
CallHandler.handleBatch()
      |
      |-- Parse & validate CSV (~5ms)
      |-- Store invalid records -> Dead Letter Queue 
      |-- Enqueue valid records -> Pushed to Queue (~1ms)
      |-- Return { ok: true } (acknowledges receipt <500ms)

      (independently, in the background)

Queue -> CallProcessor
      |
      |-- All 20 operator lookups concurrently
      |     |-- lookupOperator(fromNumber)  x 10 records
      |     |-- lookupOperator(toNumber)    x 10 records
      |
      |-- Calculate duration + estimated cost
      |-- Write to DB + Search Index in parallel
```

## Key Design Decisions

### Async Queue Pattern

The handler's only job is to validate and acknowledge receipt. Enrichment and storage happen asynchronously in the background via an in-memory queue. In production this would be an **AWS SQS FIFO queue** triggering a separate Lambda consumer.

SQS FIFO was chosen specifically because:
- Guarantees exactly-once processing - no duplicate CDR enrichment
- Maintains batch ordering
- Supports 3000 messages/sec with batching - as SQS allows 10 messages per operation
- Native integration with the AWS stack 

### Parallel Operator Lookups

All operator lookups across the entire batch run concurrently using `Promise.allSettled`. For a batch of 10 records (20 lookups), total lookup time ≈ slowest single lookup (~300ms) rather than sequential time (~6000ms).

`Promise.allSettled` is used over `Promise.all` so a single failed lookup doesn't lose enrichment data for the rest of the batch.

### Retry with Exponential Backoff

The operator lookup API has a ~5% failure rate. Each lookup is retried up to 3 times with exponential backoff (100ms, 200ms, 300ms) before being marked as failed. A partial enrichment (missing operator fields) is always preferred over losing the record entirely.

### Dead Letter Pattern

Invalid records are routed here rather than silently dropped. In production this would be an SQS Dead Letter Queue, keeping the error handling path decoupled from the main processing flow. CloudWatch alarms on DLQ depth would alert the ops team when records are backing up. The team can then inspect, fix, and reprocess as needed.

### Storage: DynamoDB + OpenSearch

Two stores serve different query patterns:

- **DynamoDB** - source of truth, fast single-number lookups (PK: phoneNumber, SK: callStartTime). Chosen for automatic scaling, single-digit millisecond reads and native AWS integration
- **OpenSearch** - derived search index for complex cross-record queries and real-time fraud pattern detection. Enables queries like "all calls from US numbers to UK numbers in the last hour" which aren't possible in DynamoDB alone

Both are written to in parallel after enrichment.

## Storage Architecture

### Database — MockDatabase (→ DynamoDB)

The mock uses an in-memory Map keyed by record ID. In production this would be replaced with DynamoDB using a single-table design:

- **PK**: `phoneNumber`, **SK**: `callStartTime`
- Fast lookups like "all calls from +14155551234 in the last 7 days"
- `BatchWriteItem` for writes (up to 25 items per request)
- TTL on records to automatically expire old CDR data
- Native AWS integration with Lambda and SQS

### Search Index — MockSearchIndex (OpenSearch)

Mirrors the OpenSearch integration referenced in the job spec. The bulk API would be used for indexing; fraud detection queries would use the OpenSearch query DSL with `bool/should` term matching across `fromNumber` and `toNumber`.

Field mappings in production:
- `fromNumber`, `toNumber` — `keyword` (exact match)
- `callStartTime` — `date` (range queries)
- `fromCountry`, `toCountry` — `keyword` (aggregations)
- `duration`, `estimatedCost` — `numeric` (aggregations)

OpenSearch also enables Kibana dashboards for visualising call patterns and cross-record queries (e.g. "all calls from US numbers to UK numbers in the last hour").

### Dead Letter Store — MockDeadLetterStore (SQS DLQ)

Invalid records are routed here rather than silently dropped. In production this would be an SQS Dead Letter Queue, keeping the error handling path decoupled from the main processing flow. CloudWatch alarms on DLQ depth would alert the ops team when records are backing up. The team can then inspect, fix, and reprocess as needed.

## Dependencies

**Papa Parse** (CSV parsing) - I try to keep dependencies to a minimum, so every package has to earn its keep. From doing research online, I chose Papa Parse because writing a custom CSV parser usually ends in tears. A simple .split(',') works fine right up until a user uploads a file with a comma inside a quoted string or weird line endings. Over the top for this take-home for sure - but as with every other decision, I wanted to build production-ready foundation, including handling edge cases early.

**Jest + ts-jest** — Testing framework