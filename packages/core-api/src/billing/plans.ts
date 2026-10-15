export type PlanId = 'free' | 'pro';

export interface PlanLimits {
  /** Max rows per export (null = unlimited). */
  maxExportRows: number | null;
  /** Max active field rules (null = unlimited). */
  maxFieldRules: number | null;
  /** Max sheets per multi-tab workbook. */
  maxWorkbookSheets: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;
  limits: PlanLimits;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: 'free', name: 'Free', priceUsdMonthly: 0, limits: { maxExportRows: 250, maxFieldRules: 2, maxWorkbookSheets: 1 } },
  pro: { id: 'pro', name: 'Pro', priceUsdMonthly: 19, limits: { maxExportRows: null, maxFieldRules: null, maxWorkbookSheets: 10 } },
};

/** Hard technical ceiling even for Pro (memory guard per export session). */
export const ABSOLUTE_MAX_EXPORT_ROWS = 1_000_000;
