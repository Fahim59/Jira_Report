// Custom Report layout model. Pure: no Node/Fastify imports.
import { z } from 'zod';
import { isMetricField, isValidFieldId } from './filter.js';

export const MAX_GROUP_LEVELS = 3;
export const MAX_COLUMNS = 20;
export const PERIODS = ['none', 'day', 'week', 'month', 'quarter', 'year'] as const;

export const fieldIdSchema = z.string().trim().min(1).max(100).refine(isValidFieldId, 'is not a valid field id');
const fieldId = fieldIdSchema.refine((id) => !isMetricField(id), 'is only available in each-worklog / each-issue sheets');

export const LayoutSchema = z.object({
  groupBy: z
    .array(fieldId)
    .min(1, 'group by at least one field')
    .max(MAX_GROUP_LEVELS, `group by at most ${MAX_GROUP_LEVELS} fields`)
    .refine((ids) => new Set(ids).size === ids.length, 'a field can be used only once in group by'),
  columns: z
    .array(fieldId)
    .max(MAX_COLUMNS, `at most ${MAX_COLUMNS} extra columns`)
    .default([])
    .transform((ids) => [...new Set(ids)]),
  period: z.enum(PERIODS).default('none'),
  format: z.enum(['hours', 'days']).default('hours'),
  sumSubtasksToParent: z.boolean().default(false),
  sort: z.enum(['value', 'totalDesc']).default('value'),
});

export type Layout = z.infer<typeof LayoutSchema>;
export type Period = Layout['period'];
export type TimeFormat = Layout['format'];

/** Seconds in the layout's unit: hours, or days of `hoursPerDay` hours. Unrounded. */
export function toUnit(seconds: number, format: TimeFormat, hoursPerDay: number): number {
  const hours = seconds / 3600;
  return format === 'days' ? hours / hoursPerDay : hours;
}

/** "7.5h" / "0.94d": at most 2 decimals, trailing zeros dropped. */
export function formatAmount(seconds: number, format: TimeFormat, hoursPerDay: number): string {
  const n = Math.round(toUnit(seconds, format, hoursPerDay) * 100) / 100;
  return `${n}${format === 'days' ? 'd' : 'h'}`;
}
