/** 方位角基准：磁北 / 真北 */
export type DatumKind = 'magnetic' | 'true'

export const DATUM_LABELS: Record<DatumKind, string> = {
  magnetic: '磁北',
  true: '真北'
}

/** 批次状态：待补磁偏角 / 基准可用 / 更正失败（待外业班重试） */
export type BatchStatus = 'pending' | 'ready' | 'failed'

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  pending: '待补磁偏角',
  ready: '基准可用',
  failed: '更正失败'
}

/** 更正动作：补磁偏角 / 整批改判真北 */
export type CorrectionAction = 'declination' | 'rejudge'

export const CORRECTION_ACTION_LABELS: Record<CorrectionAction, string> = {
  declination: '补磁偏角',
  rejudge: '整批改判真北'
}

/** SurveyBatch 测量批次：外业班保管读数与当时的方位角基准 */
export interface SurveyBatch {
  id: string
  caveId: string
  /** 批次号，如 B-01 */
  code: string
  /** 方位角基准 */
  datum: DatumKind
  /** 磁偏角（十进制度，东偏为正）；磁北批次补录后参与真北归算 */
  declination: number | null
  status: BatchStatus
  /** 外业班记录人 */
  keeper: string
  /** 测回情况备注 */
  spanNote: string
  createdAt: string
}

/** CorrectionLog 更正记录：每次补磁偏角 / 改判真北的成功与失败均留痕 */
export interface CorrectionLog {
  id: string
  batchId: string
  caveId: string
  action: CorrectionAction
  /** 本次补录的磁偏角（改判真北时为 null） */
  declination: number | null
  result: 'success' | 'failed'
  /** 转待核的图幅数 */
  affectedSheets: number
  /** 经办（外业班） */
  operator: string
  message: string
  createdAt: string
}
