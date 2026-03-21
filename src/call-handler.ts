import { parseCSV } from './csv-parser';
import { Queue } from './queue';
import { CallProcessor } from './call-processor';
import { MockDeadLetterStore } from './mock-dead-letter-store';
import { MockDatabase } from './mock-db';
import { MockSearchIndex } from './mock-search';

type Response = {
  ok: boolean;
  error?: string;
};

const deadLetterStore = new MockDeadLetterStore();
const db = new MockDatabase();
const searchIndex = new MockSearchIndex();
const processor = new CallProcessor(db, searchIndex, deadLetterStore);
const queue = new Queue(processor);

export class CallHandler {
  public async handleBatch(payload: string): Promise<Response> {
    // Empty payload means something's wrong upstream - acknowledge and move on
    if (!payload || payload.trim() === '') {
      console.log({ event: 'EMPTY_PAYLOAD_RECEIVED', timestamp: new Date().toISOString() });
      return { ok: true };
    }

    const { valid, invalid } = parseCSV(payload);

    if (invalid.length > 0) {
      await deadLetterStore.saveBatch(invalid);
      console.log({
        event: 'INVALID_RECORDS_STORED',
        count: invalid.length,
        timestamp: new Date().toISOString()
      });
    }

    if (valid.length > 0) {
      queue.enqueue(valid);
    }

    return { ok: true };
  }
}