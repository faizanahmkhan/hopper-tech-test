import { CallRecord, EnrichedCallRecord, OperatorInfo } from './call-record.i';
import { lookupOperator } from './operator-lookup';
import { MockDatabase } from './mock-db';
import { MockDeadLetterStore } from './mock-dead-letter-store';
import { MockSearchIndex } from './mock-search';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY_MS
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      // Exponential backoff - wait longer between each retry
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
      console.log({
        event: 'OPERATOR_LOOKUP_RETRY',
        attempt,
        nextRetryMs: delayMs * attempt,
        timestamp: new Date().toISOString()
      });
    }
  }
  throw new Error('Unreachable');
}

  // Returns duration in seconds
function calculateDuration(startTime: string, endTime: string): number {
  return (new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000;
}

function calculateCost(durationSeconds: number, costPerMinute: number): number {
  const durationMinutes = durationSeconds / 60;
  return Math.round(durationMinutes * costPerMinute * 10000) / 10000; // 4dp avoids float drift
}

// Operator lookup API expects 'yy-MM-dd', not ISO 8601
function formatCallDate(isoDate: string): string {
  const date = new Date(isoDate);
  const yy = date.getUTCFullYear().toString().slice(2);
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function enrichRecord(record: CallRecord): Promise<EnrichedCallRecord> {
  const callDate = formatCallDate(record.callStartTime);
  const duration = calculateDuration(record.callStartTime, record.callEndTime);

  const [fromResult, toResult] = await Promise.allSettled([
    withRetry(() => lookupOperator(record.fromNumber, callDate)),
    withRetry(() => lookupOperator(record.toNumber, callDate))
  ]);

  const fromInfo: OperatorInfo | undefined =
    fromResult.status === 'fulfilled' ? fromResult.value : undefined;
  const toInfo: OperatorInfo | undefined =
    toResult.status === 'fulfilled' ? toResult.value : undefined;

  if (fromResult.status === 'rejected') {
    console.error({
      event: 'OPERATOR_LOOKUP_FAILED',
      recordId: record.id,
      phoneNumber: record.fromNumber,
      error: fromResult.reason?.message ?? 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }

  if (toResult.status === 'rejected') {
    console.error({
      event: 'OPERATOR_LOOKUP_FAILED',
      recordId: record.id,
      phoneNumber: record.toNumber,
      error: toResult.reason?.message ?? 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }

  const estimatedCost = fromInfo
    ? calculateCost(duration, fromInfo.estimatedCostPerMinute)
    : undefined;

  return {
    ...record,
    duration,
    fromOperator: fromInfo?.operator,
    fromCountry: fromInfo?.country,
    toOperator: toInfo?.operator,
    toCountry: toInfo?.country,
    estimatedCost
  };
}

export class CallProcessor {
  private db: MockDatabase;
  private searchIndex: MockSearchIndex;
  private deadLetterStore: MockDeadLetterStore;

  constructor(
    db: MockDatabase,
    searchIndex: MockSearchIndex,
    deadLetterStore: MockDeadLetterStore
  ) {
    this.db = db;
    this.searchIndex = searchIndex;
    this.deadLetterStore = deadLetterStore;
  }

  public async processBatch(batch: CallRecord[]): Promise<void> {
    console.log({
      event: 'BATCH_PROCESSING_STARTED',
      batchSize: batch.length,
      timestamp: new Date().toISOString()
    });

    // Enrich all records in parallel - all lookups across all records run concurrently
    const enrichmentResults = await Promise.allSettled(
      batch.map(record => enrichRecord(record))
    );

    const enrichedRecords: EnrichedCallRecord[] = [];
    const failedRecords: { row: unknown; reason: string }[] = [];

    for (let i = 0; i < enrichmentResults.length; i++) {
      const result = enrichmentResults[i];
      const originalRecord = batch[i]; // allSettled preserves order

      if (result.status === 'fulfilled') {
        enrichedRecords.push(result.value);
      } else {
        console.error({
          event: 'RECORD_ENRICHMENT_FAILED',
          recordId: originalRecord.id,
          error: result.reason?.message ?? 'Unknown error',
          timestamp: new Date().toISOString()
        });

        // Push to DLQ - record is preserved for investigation and reprocessing
        // In production: publish to SQS DLQ
        failedRecords.push({
          row: originalRecord,
          reason: result.reason?.message ?? 'Enrichment failed'
        });
      }
    }

    if (failedRecords.length > 0) {
      await this.deadLetterStore.saveBatch(failedRecords);
    }

    // Write to DB and search index in parallel - independent operations
    await Promise.all([
      this.db.saveBatch(enrichedRecords),
      this.searchIndex.indexBatch(enrichedRecords)
    ]);

    console.log({
      event: 'BATCH_PROCESSING_COMPLETE',
      enrichedCount: enrichedRecords.length,
      failedCount: failedRecords.length,
      timestamp: new Date().toISOString()
    });
  }
}