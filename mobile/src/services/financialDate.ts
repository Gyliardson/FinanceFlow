export const FINANCIAL_TIME_ZONE = 'America/Sao_Paulo';

export interface FinancialDateParts {
  year: number;
  month: number;
  day: number;
}

const FINANCIAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: FINANCIAL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFromFormatter = (instant: Date | number): FinancialDateParts => {
  const date = typeof instant === 'number' ? new Date(instant) : instant;
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error('A valid instant is required for the financial calendar.');
  }

  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = part.value;
    }
  }

  const year = Number(values.year);
  const month = Number(values.month);
  const day = Number(values.day);
  if (!year || !month || !day) {
    throw new Error('The financial calendar formatter returned invalid date parts.');
  }
  return { year, month, day };
};

export const financialDateParts = (instant: Date | number = Date.now()): FinancialDateParts =>
  partsFromFormatter(instant);

export const financialDateOnly = (instant: Date | number = Date.now()): string => {
  const { year, month, day } = financialDateParts(instant);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const parseFinancialDateOnly = (value: string): FinancialDateParts => {
  const match = FINANCIAL_DATE_RE.exec(value);
  if (!match) throw new Error('Financial date must use YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() !== month - 1
    || candidate.getUTCDate() !== day
  ) {
    throw new Error('Financial date is not a real calendar date.');
  }
  return { year, month, day };
};

export const compareFinancialDateOnly = (left: string, right: string): number => {
  parseFinancialDateOnly(left);
  parseFinancialDateOnly(right);
  return left < right ? -1 : left > right ? 1 : 0;
};

export const financialDaysBetween = (from: string, to: string): number => {
  const left = parseFinancialDateOnly(from);
  const right = parseFinancialDateOnly(to);
  const leftUtc = Date.UTC(left.year, left.month - 1, left.day);
  const rightUtc = Date.UTC(right.year, right.month - 1, right.day);
  return Math.round((rightUtc - leftUtc) / 86_400_000);
};

export const formatFinancialDatePtBr = (value: string): string => {
  const { year, month, day } = parseFinancialDateOnly(value);
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${String(year).padStart(4, '0')}`;
};
