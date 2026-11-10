import type { Operation } from '../../src/lib/types'
import type { PlanningRecord } from '../../src/lib/planning-types'
export function validPlanning(record: unknown): record is PlanningRecord
export function localDay(now?: Date): string
export function financials(operations: Operation[], planning: PlanningRecord[], now?: Date): { balance: number | null; reserved: number; free: number | null; reserves: Record<string, number>; invalid: boolean; anchor?: PlanningRecord; pending: PlanningRecord[] }
export function duePeriods(envelope: PlanningRecord, through: string): string[]
export function nextPaymentPeriod(envelope: PlanningRecord, operations: Operation[], now?: Date): string | undefined
export function obligations(operations: Operation[], planning: PlanningRecord[], now?: Date): { envelope: PlanningRecord; period: string; paid: number; missing: number }[]
export function distribution(operations: Operation[], planning: PlanningRecord[], now?: Date): { envelopeId: string; name: string; amount: number }[]
export function movementError(operations: Operation[], planning: PlanningRecord[], event: PlanningRecord, now?: Date): string | null
