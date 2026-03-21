import { CallRecord } from './call-record.i';
import { CallProcessor } from './call-processor';

// In prod: SQS FIFO — exactly-once processing, guaranteed ordering
export class Queue {
  private queue: CallRecord[][] = [];
  private processor: CallProcessor;
  private isProcessing: boolean = false;

  constructor(processor: CallProcessor) {
    this.processor = processor;
  }

  public enqueue(batch: CallRecord[]): void {
    this.queue.push(batch);
    console.log({
      event: 'BATCH_ENQUEUED',
      batchSize: batch.length,
      queueDepth: this.queue.length,
      timestamp: new Date().toISOString()
    });

    // Fire and forget - this is the decoupling point
    // In prod: SQS triggers the consumer Lambda automatically
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const batch = this.queue.shift()!;
      try {
        await this.processor.processBatch(batch);
      } catch (error) {
        // In prod: SQS moves to DLQ after max receive count exceeded
        console.error({
          event: 'BATCH_PROCESSING_FAILED',
          batchSize: batch.length,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        });
      }
    }

    this.isProcessing = false;
  }
}