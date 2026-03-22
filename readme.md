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

The main constraint is the sub-500ms acknowledgment SLA — you can't do operator lookups and DB writes inside that window, so the handler just validates, enqueues and returns. Enrichment happens in the background.
```
Upstream System
      |
CallHandler.handleBatch()
      |
      |-- Parse & validate CSV (~5ms)
      |-- Invalid records → Dead Letter Queue
      |-- Valid records → Enqueued (~1ms)
      |-- Return { ok: true }  ← <500ms

      (independently, in the background)

Queue → CallProcessor
      |
      |-- 20 operator lookups concurrently
      |     |-- lookupOperator(fromNumber)  x 10 records
      |     |-- lookupOperator(toNumber)    x 10 records
      |
      |-- Calculate duration + estimated cost
      |-- Write to DB + Search Index in parallel
```

In production the in-memory queue would be SQS FIFO triggering a separate Lambda — the handler publishes and returns, the consumer does the heavy lifting.

## Key Design Decisions

### Async Queue Pattern
The handler validates, enqueues and gets out of the way. SQS FIFO in production because it gives exactly-once processing (no duplicate enrichment), maintains ordering, and fits naturally into the AWS stack.

### Parallel Operator Lookups
Every lookup across the whole batch runs concurrently. For 10 records that's 20 lookups running at once — total time ends up around the slowest single lookup (~300ms) instead of waiting on each one sequentially (~6,000ms).

`Promise.allSettled` rather than `Promise.all` so one bad lookup doesn't tank the whole batch. It also preserves order, which matters when routing failures back to the DLQ.

### Retry with Exponential Backoff
The lookup API fails roughly 5% of the time so each call gets up to 3 retries with exponential backoff (100ms -> 200ms -> 400ms). A record with missing operator fields is still worth keeping — better than dropping it entirely.

### Dead Letter Pattern
Bad records go to the DLQ instead of disappearing silently. In production that's SQS DLQ with CloudWatch alarms on depth - ops gets alerted when things back up and can inspect and reprocess without any data being permanently lost.

### Storage: DynamoDB + OpenSearch
DynamoDB as the source of truth for fast single-number lookups, OpenSearch alongside it for the queries DynamoDB can't handle — things like "all calls from US to UK numbers in the last hour" or aggregating by country for fraud detection. Both get written in parallel since they're completely independent.


## Running the Tests
```bash
npm install
npm test
```

## Dependencies

**Papa Parse** — I try to keep dependencies minimal but CSV parsing is one where rolling your own usually ends in tears. A `.split(',')` gets you 80% of the way there until someone uploads a file with commas inside quoted fields or weird line endings. Overkill for a take-home, but felt wrong to cut corners on something that would bite you immediately in production.

**Jest + ts-jest** — testing framework

## AI Usage

Claude was used as a sounding board while working through the architecture and to assist with intial boilerplate.


## What I Would Add With More Time

- **Redis caching for operator lookups** — the same numbers will come up repeatedly across batches, no point hitting the API every time
- **CloudWatch metrics** — processing time, lookup failure rates, DLQ depth. Alarms before things become a pattern rather than after
- **DLQ reprocessing** — right now failed records sit in the store but there's no mechanism to replay them once the underlying issue is fixed
- **Integration tests** — the unit tests cover the pieces, would want end-to-end coverage of the full ingestion flow