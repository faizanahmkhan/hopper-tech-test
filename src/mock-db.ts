import { EnrichedCallRecord } from './call-record.i';

// PK: phoneNumber, SK: callStartTime
// Swap out for DynamoDB BatchWriteItem in prod
export class MockDatabase {
  private store: Map<string, EnrichedCallRecord> = new Map();

  public async saveBatch(records: EnrichedCallRecord[]): Promise<void> {
    for (const record of records) {
      this.store.set(record.id, record);
      console.log({ event: 'DB_RECORD_SAVED', recordId: record.id, timestamp: new Date().toISOString() });
    }
  }

  public async getById(id: string): Promise<EnrichedCallRecord | undefined> {
    return this.store.get(id);
  }

  public async getAll(): Promise<EnrichedCallRecord[]> {
    return Array.from(this.store.values());
  }
}