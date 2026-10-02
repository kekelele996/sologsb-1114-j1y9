/** 方位基准：磁北（早年罗盘读数）/ 真北（改判后统一基准） */
export const BEARING_DATUMS = ['magnetic', 'true'] as const
export type BearingDatum = (typeof BEARING_DATUMS)[number]

export const BEARING_DATUM_LABELS: Record<BearingDatum, string> = {
  magnetic: '磁北',
  true: '真北'
}

/** 图幅（草图）基准核认状态：更正后先转待核，制图室逐张认过 */
export const SHEET_STATUSES = ['unaffected', 'pending', 'approved'] as const
export type SheetStatus = (typeof SHEET_STATUSES)[number]

export const SHEET_STATUS_LABELS: Record<SheetStatus, string> = {
  unaffected: '无需核认',
  pending: '待核',
  approved: '已认过'
}

/**
 * 测量批次：外业班按批次保存读数与其当时基准。
 * 旧数据无基准记载时，在 v3 迁移里整体归入「最早一批」。
 */
export interface SurveyBatch {
  id: string
  caveId: string
  /** 批次编号，如 B-01 */
  code: string
  /** 该批读数记录时使用的方位基准 */
  datum: BearingDatum
  /** 磁偏角（十进制度，东偏为正、西偏为负）；真北基准下为 0 */
  declination: number
  /** 外业测量日期 */
  measuredAt: string
  note: string
  createdAt: string
}

/** 对账行：外业班读数（测点）与制图室图幅（草图）跨基准逐段对照 */
export interface ReconcileRow {
  stationId: string
  stationCode: string
  segmentId: string
  segmentCode: string
  sketchId: string
  sketchCode: string
  batchId: string
  batchCode: string
  datum: BearingDatum
  declination: number
  /** 读数原始方位角（按其记录基准） */
  rawBearing: number
  /** 统一折算到真北后的方位角 */
  trueBearing: number
  /** 两边相差（折算后应趋于 0）；这里反映该读数相对真北仍悬着的磁偏角 */
  delta: number
}

/** 一次整批改判 / 补磁偏角更正的执行结果 */
export interface CorrectionResult {
  ok: boolean
  /** 受影响测点数 */
  stationCount: number
  /** 被转「待核」的图幅数（已认过的保留） */
  sheetPendingCount: number
  /** 保留未动的已认过图幅数 */
  sheetKeptCount: number
  mode: 'annotate' | 'true'
  message: string
}
