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

In production this queue would be an **AWS SQS FIFO queue** triggering a separate Lambda consumer. The handler Lambda publishes and returns immediately — the consumer Lambda handles enrichment and storage independently.


## Key Design Decisions

### Async Queue Pattern

The handler's only job is to validate and acknowledge receipt. Enrichment and storage happen asynchronously in the background. SQS FIFO was chosen specifically because:
- Guarantees exactly-once processing — no duplicate CDR enrichment
- Maintains batch ordering
- Supports up to 3000 messages/sec with batching
- Native integration with the AWS stack Smartnumbers uses

### Parallel Operator Lookups

All operator lookups across the entire batch run concurrently using `Promise.allSettled`. For a batch of 10 records (20 lookups), total lookup time ≈ slowest single lookup (~300ms) rather than sequential (~6000ms).

`Promise.allSettled` is used over `Promise.all` so a single failed lookup doesn't lose enrichment data for the rest of the batch. It also preserves input order so failed enrichments can be matched back to their original record for the DLQ.

### Retry with Exponential Backoff

The operator lookup API has a ~5% failure rate. Each lookup is retried up to 3 times with exponential backoff (100ms, 200ms, 300ms) before being marked as failed. A partial enrichment (missing operator fields) is always preferred over losing the record entirely.

### Dead Letter Pattern

Invalid records are routed here rather than silently dropped. In production this would be an SQS Dead Letter Queue, keeping the error handling path decoupled from the main processing flow. CloudWatch alarms on DLQ depth would alert the ops team when records are backing up. The team can then inspect, fix, and reprocess as needed.

### Storage: DynamoDB + OpenSearch

Two stores serve different query patterns:

- **DynamoDB** - source of truth, fast single-number lookups (PK: phoneNumber, SK: callStartTime). Chosen for automatic scaling, single-digit millisecond reads and native AWS integration
- **OpenSearch** - derived search index for complex cross-record queries and real-time fraud pattern detection. Enables queries like "all calls from US numbers to UK numbers in the last hour" which aren't possible in DynamoDB alone

Both are written to in parallel after enrichment as they are independent operations.

## Running the Tests
```bash
npm install
npm test
```

## Dependencies

**Papa Parse** (CSV parsing) - I try to keep dependencies to a minimum, so every package has to earn its keep. From doing research online, I chose Papa Parse because writing a custom CSV parser usually ends in tears. A simple `.split(',')` works fine right up until a user uploads a file with a comma inside a quoted string or weird line endings. Over the top for this take-home for sure - but as with every other decision, I wanted to build production-ready foundation, including handling edge cases early.

**Jest + ts-jest** — Testing framework

## AI Usage

Claude was used to discuss and validate architectural decisions. All code has been reviewed and understood before submission. The architectural decisions, validation logic and overall structure reflect my own understanding of the problem — I was also asked to reason through each decision myself before seeing any implementation.

## What I Would Add With More Time

- **Redis caching on operator lookups** — the same phone numbers appear repeatedly across CDR batches. A cache would dramatically reduce API calls over time
- **CloudWatch metrics** — emit structured metrics on batch processing time, lookup failure rates and DLQ depth with alarms so the team is alerted before failures become a pattern
- **DLQ reprocessing** — a mechanism to replay records from the Dead Letter Store once upstream issues are resolved, so no data is permanently lost
- **Integration tests** — testing the full flow from CSV ingestion through to storage