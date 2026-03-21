import { EnrichedCallRecord } from './call-record.i';

// Index: enriched-call-records
// In prod this would be OpenSearch Bulk API
export class MockSearchIndex {
  private index: Map<string, EnrichedCallRecord> = new Map();

  public async indexBatch(records: EnrichedCallRecord[]): Promise<void> {
    for (const record of records) {
      this.index.set(record.id, record);
      console.log({ event: 'SEARCH_RECORD_INDEXED', recordId: record.id, timestamp: new Date().toISOString() });
    }
  }

  // Mirrors how fraud detection queries would hit OpenSearch in prod
  public async findByPhoneNumber(phoneNumber: string): Promise<EnrichedCallRecord[]> {
    return Array.from(this.index.values()).filter(
      record => record.fromNumber === phoneNumber || record.toNumber === phoneNumber
    );
  }
}