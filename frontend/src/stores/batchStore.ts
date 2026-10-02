import { createStore } from 'zustand/vanilla'
import type { CorrectionAction, CorrectionLog, Sketch, SurveyBatch } from '@/types'
import { CORRECTION_ACTION_LABELS } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'
import { sketchStore } from '@/stores/sketchStore'
import { isValidDeclination, DECLINATION_LIMIT } from '@/utils/survey'
import { uid } from '@/utils/id'

export interface CorrectionInput {
  batchId: string
  action: CorrectionAction
  /** 补磁偏角时必填；改判真北时忽略 */
  declination: number | null
  /** 经办（外业班） */
  operator: string
}

export interface CorrectionOutcome {
  ok: boolean
  message: string
}

export interface BatchState {
  batches: SurveyBatch[]
  corrections: CorrectionLog[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (batch: SurveyBatch) => Promise<void>
  /** 洞穴下没有任何批次时，为洞穴补建现行真北默认批次（新读数用） */
  ensureDefault: (caveId: string) => Promise<SurveyBatch>
  /** 基准更正：补磁偏角 / 整批改判真北；失败留痕并可按外业班重试，已认过图幅保留 */
  runCorrection: (input: CorrectionInput) => Promise<CorrectionOutcome>
}

/** 洞穴内下一个批次号，如 B-03 */
export function nextBatchCode(batches: SurveyBatch[], caveId: string): string {
  const numbers = batches
    .filter((batch) => batch.caveId === caveId)
    .map((batch) => {
      const match = /^B-(\d+)$/.exec(batch.code.trim())
      return match ? Number(match[1]) : 0
    })
  const max = numbers.length > 0 ? Math.max(...numbers) : 0
  return `B-${String(max + 1).padStart(2, '0')}`
}

export const batchStore = createStore<BatchState>((set, get) => ({
  batches: [],
  corrections: [],
  loaded: false,
  hydrate: async () => {
    const batches = await syncAll<SurveyBatch>(db.batches)
    batches.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    const corrections = await syncAll<CorrectionLog>(db.corrections)
    corrections.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    set({ batches, corrections, loaded: true })
  },
  save: async (batch) => {
    await syncPut<SurveyBatch>(db.batches, batch)
    await get().hydrate()
  },
  ensureDefault: async (caveId) => {
    const existing = get().batches.filter((batch) => batch.caveId === caveId)
    if (existing.length > 0) {
      return [...existing].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    }
    const batch: SurveyBatch = {
      id: uid('batch'),
      caveId,
      code: 'B-01',
      datum: 'true',
      declination: null,
      status: 'ready',
      keeper: '',
      spanNote: '现行真北基准（录入测点时自动建立）',
      createdAt: new Date().toISOString()
    }
    await syncPut<SurveyBatch>(db.batches, batch)
    await get().hydrate()
    return batch
  },
  runCorrection: async ({ batchId, action, declination, operator }) => {
    const batch = get().batches.find((item) => item.id === batchId)
    if (!batch) return { ok: false, message: '批次不存在' }

    const now = new Date().toISOString()
    const writeLog = async (result: CorrectionLog['result'], message: string, affectedSheets: number): Promise<void> => {
      await syncPut<CorrectionLog>(db.corrections, {
        id: uid('corr'),
        batchId: batch.id,
        caveId: batch.caveId,
        action,
        declination: action === 'declination' ? declination : null,
        result,
        affectedSheets,
        operator: operator.trim() || '外业班',
        message,
        createdAt: now
      })
    }

    // 校验失败：不改数据，批次标记「更正失败」，外业班修正后可重试
    let failReason = ''
    if (action === 'declination') {
      if (batch.datum !== 'magnetic') failReason = '该批次已是真北基准，无需补磁偏角'
      else if (!isValidDeclination(declination)) failReason = `磁偏角缺失或超出 ±${DECLINATION_LIMIT}° 合理范围`
    } else if (batch.datum === 'true') {
      failReason = '该批次已是真北基准，无需改判'
    }
    if (failReason) {
      const message = `${failReason}，更正失败，请外业班修正后重试`
      await syncPut<SurveyBatch>(db.batches, { ...batch, status: 'failed' })
      await writeLog('failed', message, 0)
      await get().hydrate()
      return { ok: false, message }
    }

    // 应用新基准：读数保持原样，基准与磁偏角记在批次上
    const updated: SurveyBatch =
      action === 'declination'
        ? { ...batch, declination, status: 'ready' }
        : { ...batch, datum: 'true', declination: null, status: 'ready' }

    // 受影响图幅 = 含本批次测点的洞段下的草图；已认过的图幅留着，不再转待核
    const stations = await db.stations.where('batchId').equals(batchId).toArray()
    const segmentIds = new Set(stations.map((station) => station.segmentId))
    const affected = (await db.sketches.toArray()).filter(
      (sketch) => segmentIds.has(sketch.segmentId) && sketch.reviewStatus !== 'confirmed'
    )
    const actionLabel = CORRECTION_ACTION_LABELS[action]
    const reviewNote =
      action === 'declination'
        ? `批次 ${batch.code} 补磁偏角 ${declination}°，折线按真北重算，转待核`
        : `批次 ${batch.code} 整批改判真北，折线按真北重算，转待核`

    await db.transaction('rw', [db.batches, db.sketches, db.corrections], async () => {
      await db.batches.put(updated)
      for (const sketch of affected) {
        const next: Sketch = { ...sketch, reviewStatus: 'pending', reviewNote }
        await db.sketches.put(next)
      }
    })
    const message = `批次 ${batch.code} ${actionLabel}完成，闭合差与草图折线已按新基准重算，${affected.length} 张图幅转待核`
    await writeLog('success', message, affected.length)
    await get().hydrate()
    await sketchStore.getState().hydrate()
    return { ok: true, message }
  }
}))
