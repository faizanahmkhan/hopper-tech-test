// Invalid records land here rather than getting silently dropped
// In prod: SQS DLQ — ops team can inspect, fix, and reprocess
export class MockDeadLetterStore {
  private store: { row: unknown; reason: string; timestamp: string }[] = [];

  public async saveBatch(records: { row: unknown; reason: string }[]): Promise<void> {
    for (const record of records) {
      const entry = { ...record, timestamp: new Date().toISOString() };
      this.store.push(entry);
      console.error({ event: 'DEAD_LETTER_RECORD_STORED', reason: record.reason, timestamp: entry.timestamp });
    }
  }

  public getAll(): { row: unknown; reason: string; timestamp: string }[] {
    return [...this.store];
  }
}