/** 图幅核认状态：待核 / 认过 */
export type ReviewStatus = 'pending' | 'confirmed'

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: '待核',
  confirmed: '认过'
}

/** Sketch 草图 */
export interface Sketch {
  id: string
  segmentId: string
  /** 草图编号 */
  code: string
  /** 坐标纸格数 */
  gridCount: number
  /** 缩放比例（1:N 的 N，如 200 表示 1:200） */
  scale: number
  /** 绘制人 */
  author: string
  /** 图幅拼合顺序号 */
  mergeOrder: number
  /** 桩号对齐锚点 */
  anchorStake: string
  /** 图片数据说明 */
  imageNote: string
  /** 核认状态：基准更正后转待核，由制图室逐张认过 */
  reviewStatus: ReviewStatus
  /** 最近一次转待核的原因 */
  reviewNote: string
}

/** 图幅拼合对齐结果 */
export interface MergeItem {
  sketchId: string
  /** 对齐后的横向偏移（单位：格） */
  offset: number
  /** 是否已吸附到锚点 */
  snapped: boolean
}
