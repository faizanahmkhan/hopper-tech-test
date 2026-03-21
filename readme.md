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
I have littered the whole project with comments to explain thought process

## Architecture Overview

The core challenge is meeting the sub-500ms acknowledgment SLA while performing slow external API calls (operator lookups) and database writes. The solution decouples receipt acknowledgment from processing using an async queue pattern.

 // Will be drawing a system design style 
Upstream System
      |
CallHandler.handleBatch()
      |
      |-- Parse & validate CSV (~5ms)
      |-- Store invalid records -> Dead Letter Queue 
      |-- Enqueue valid records -> Pushed to Queue (~1ms)
      |-- Return { ok: true } (acknowledges receipt <500ms)

      *independently, in the background*

Queue -> CallProcessor
      |
      |-- All 20 operator lookups concurrently
      |     |-- lookupOperator(fromNumber)  x 10 records
      |     |-- lookupOperator(toNumber)    x 10 records
      |
      |-- Calculate duration + estimated cost
      |-- Write to DB + Search Index in parallel

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
Invalid records (failed validation) and records that fail enrichment after all retries are stored in a Dead Letter Store rather than silently dropped. 

In production this would be an **AWS SQS Dead Letter Queue (DLQ)** with CloudWatch alarms on queue depth.

### Storage: DynamoDB + OpenSearch
Two stores serve different query patterns:

- **DynamoDB** - source of truth, fast single-number lookups (PK: phoneNumber, SK: callStartTime). Chosen for automatic scaling, single-digit millisecond reads and native AWS integration
- **OpenSearch** - derived search index for complex cross-record queries and real-time fraud pattern detection. Enables queries like "all calls from US numbers to UK numbers in the last hour" which aren't possible in DynamoDB alone

Both are written to in parallel after enrichment.

## Dependencies

**Papa Parse** (CSV parsing) - I try to keep dependencies to a minimum, so every package has to earn its keep. From doing research online, I chose Papa Parse because writing a custom CSV parser usually ends in tears. A simple .split(',') works fine right up until a user uploads a file with a comma inside a quoted string or weird line endings. Over the top for this take-home for sure - but as with every other decision, I wanted to build production-ready foundation, including handling edge cases early.

**Jest + ts-jest** — Testing framework