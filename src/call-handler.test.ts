import { CallHandler } from './call-handler';
import { parseCSV } from './csv-parser';

// matches the example from the spec
const VALID_CSV = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:30:00.000Z,2026-01-21T14:35:30.000Z,+14155551234,+442071234567,voice,us-west
cdr_002,2026-01-21T14:31:15.000Z,2026-01-21T14:33:45.000Z,+442071234567,+14155551234,voice,eu-west`;

const INVALID_CSV = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
bad_record,not-a-date,2026-01-21T14:35:30.000Z,+14155551234,+442071234567,voice,us-west`;

const MIXED_CSV = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:30:00.000Z,2026-01-21T14:35:30.000Z,+14155551234,+442071234567,voice,us-west
bad_record,not-a-date,2026-01-21T14:35:30.000Z,+14155551234,+442071234567,voice,us-west`;

describe('parseCSV', () => {
  it('parses a valid CSV batch into CallRecords', () => {
    const { valid, invalid } = parseCSV(VALID_CSV);

    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(0);

    expect(valid[0]).toEqual({
      id: 'cdr_001',
      callStartTime: '2026-01-21T14:30:00.000Z',
      callEndTime: '2026-01-21T14:35:30.000Z',
      fromNumber: '+14155551234',
      toNumber: '+442071234567',
      callType: 'voice',
      region: 'us-west'
    });
  });

  it('returns empty arrays for an empty string', () => {
    const { valid, invalid } = parseCSV('');
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  it('returns empty arrays for a whitespace only string', () => {
    const { valid, invalid } = parseCSV('   ');
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  describe('validation', () => {
    it('puts records with invalid dates in the invalid array with a reason', () => {
      const { valid, invalid } = parseCSV(INVALID_CSV);

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
      expect(invalid[0].reason).toBe('Invalid or missing callStartTime');
    });

    it('splits a mixed batch into valid and invalid records', () => {
      const { valid, invalid } = parseCSV(MIXED_CSV);

      expect(valid).toHaveLength(1);
      expect(invalid).toHaveLength(1);
      expect(valid[0].id).toBe('cdr_001');
      expect(invalid[0].reason).toBe('Invalid or missing callStartTime');
    });

    it('rejects a record where callEndTime is before callStartTime', () => {
      const csv = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:35:30.000Z,2026-01-21T14:30:00.000Z,+14155551234,+442071234567,voice,us-west`;

      const { valid, invalid } = parseCSV(csv);
      expect(valid).toHaveLength(0);
      expect(invalid[0].reason).toBe('callEndTime must be after callStartTime');
    });

    it('rejects a record with an invalid E.164 phone number', () => {
      const csv = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:30:00.000Z,2026-01-21T14:35:30.000Z,07911123456,+442071234567,voice,us-west`;

      const { valid, invalid } = parseCSV(csv);
      expect(valid).toHaveLength(0);
      expect(invalid[0].reason).toBe('Invalid or missing fromNumber - must be E.164 format');
    });

    it('rejects a record where fromNumber and toNumber are the same', () => {
      const csv = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:30:00.000Z,2026-01-21T14:35:30.000Z,+14155551234,+14155551234,voice,us-west`;

      const { valid, invalid } = parseCSV(csv);
      expect(valid).toHaveLength(0);
      expect(invalid[0].reason).toBe('fromNumber and toNumber cannot be the same');
    });

    it('rejects a record with an invalid callType', () => {
      const csv = `id,callStartTime,callEndTime,fromNumber,toNumber,callType,region
cdr_001,2026-01-21T14:30:00.000Z,2026-01-21T14:35:30.000Z,+14155551234,+442071234567,fax,us-west`;

      const { valid, invalid } = parseCSV(csv);
      expect(valid).toHaveLength(0);
      expect(invalid[0].reason).toBe('Invalid callType - must be one of: voice, video');
    });
  });
});

describe('CallHandler', () => {
  let handler: CallHandler;

  beforeEach(() => {
    handler = new CallHandler();
  });

  it('returns { ok: true } for a valid CSV batch', async () => {
    const result = await handler.handleBatch(VALID_CSV);
    expect(result).toEqual({ ok: true });
  });

  it('acknowledges receipt in under 500ms', async () => {
    const start = Date.now();
    await handler.handleBatch(VALID_CSV);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(500);
  });

  it('returns { ok: true } for an empty payload', async () => {
    const result = await handler.handleBatch('');
    expect(result).toEqual({ ok: true });
  });

  it('returns { ok: true } for a whitespace only payload', async () => {
    const result = await handler.handleBatch('   ');
    expect(result).toEqual({ ok: true });
  });

  it('still returns { ok: true } when all records are invalid', async () => {
    const result = await handler.handleBatch(INVALID_CSV);
    expect(result).toEqual({ ok: true });
  });

  it('still returns { ok: true } for a mixed batch of valid and invalid records', async () => {
    const result = await handler.handleBatch(MIXED_CSV);
    expect(result).toEqual({ ok: true });
  });
});