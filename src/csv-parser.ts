import { CallRecord } from './call-record.i';
import Papa from 'papaparse';

const E164_REGEX = /^\+[1-9]\d{1,14}$/;
const VALID_CALL_TYPES = ['voice', 'video'] as const;

export type ParseResult = {
  valid: CallRecord[];
  invalid: { row: unknown; reason: string }[];
};

function isValidISO8601(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime());
}

function isValidE164(value: string): boolean {
  return E164_REGEX.test(value);
}

function validateRecord(row: unknown): { record: CallRecord } | { error: string } {
  // Guard against completely empty/non-object rows
  if (!row || typeof row !== 'object') {
    return { error: 'Row is not a valid object' };
  }

  const r = row as Record<string, unknown>;

  // id: must be a non-empty string
  if (!r.id || typeof r.id !== 'string' || r.id.trim() === '') {
    return { error: 'Missing or empty id' };
  }

  // callStartTime: must be present and a valid ISO 8601 date
  if (!r.callStartTime || typeof r.callStartTime !== 'string' || !isValidISO8601(r.callStartTime)) {
    return { error: 'Invalid or missing callStartTime' };
  }

  // callEndTime: must be present, valid, and after callStartTime
  if (!r.callEndTime || typeof r.callEndTime !== 'string' || !isValidISO8601(r.callEndTime)) {
    return { error: 'Invalid or missing callEndTime' };
  }

  if (new Date(r.callEndTime) <= new Date(r.callStartTime)) {
    return { error: 'callEndTime must be after callStartTime' };
  }

  // fromNumber: must be valid E.164
  if (!r.fromNumber || typeof r.fromNumber !== 'string' || !isValidE164(r.fromNumber)) {
    return { error: 'Invalid or missing fromNumber - must be E.164 format' };
  }

  // toNumber: must be valid E.164 and different from fromNumber
  if (!r.toNumber || typeof r.toNumber !== 'string' || !isValidE164(r.toNumber)) {
    return { error: 'Invalid or missing toNumber - must be E.164 format' };
  }

  if (r.fromNumber === r.toNumber) {
    return { error: 'fromNumber and toNumber cannot be the same' };
  }

  // callType: must be 'voice' or 'video'
  if (!r.callType || !VALID_CALL_TYPES.includes(r.callType as 'voice' | 'video')) {
    return { error: `Invalid callType - must be one of: ${VALID_CALL_TYPES.join(', ')}` };
  }

  // region: must be a non-empty string
  if (!r.region || typeof r.region !== 'string' || r.region.trim() === '') {
    return { error: 'Missing or empty region' };
  }

  return {
    record: {
      id: r.id.trim(),
      callStartTime: r.callStartTime,
      callEndTime: r.callEndTime,
      fromNumber: r.fromNumber,
      toNumber: r.toNumber,
      callType: r.callType as 'voice' | 'video',
      region: r.region.trim(),
    }
  };
}

export function parseCSV(payload: string): ParseResult {
  // Handle empty payload - explicitly called out in the brief
  if (!payload || payload.trim() === '') {
    return { valid: [], invalid: [] };
  }

  const { data, errors } = Papa.parse(payload, {
    header: true,        // use first row as field names
    skipEmptyLines: true // ignore blank lines
  });

  // If papaparse itself couldn't parse the CSV at all
  if (errors.length > 0 && data.length === 0) {
    return {
      valid: [],
      invalid: [{ row: payload, reason: `CSV parse error: ${errors[0].message}` }]
    };
  }

  const result: ParseResult = { valid: [], invalid: [] };

  for (const row of data) {
    const validation = validateRecord(row);

    if ('error' in validation) {
      result.invalid.push({ row, reason: validation.error });
    } else {
      result.valid.push(validation.record);
    }
  }

  return result;
}