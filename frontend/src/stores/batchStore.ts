import { createStore } from 'zustand/vanilla'
import type { CorrectionResult, Sketch, Station, SurveyBatch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'
import { magneticToTrue } from '@/utils/survey'
import { uid } from '@/utils/id'

export interface BatchState {
  batches: SurveyBatch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (batch: SurveyBatch) => Promise<void>
  remove: (id: string) => Promise<void>
  /**
   * 外业班对一批磁北读数做基准更正：
   * - annotate 补磁偏角：读数保留磁北原值，仅记磁偏角，出图/闭合差实时折算真北；
   * - true 整批改判真北：方位角重写为真北值，基准置真北。
   * 两种方式都会把受影响图幅（未认过的）转「待核」；已认过的图幅一律保留，
   * 更正校验失败时整笔事务回滚，可按外业班读数重试。
   */
  applyCorrection: (params: {
    batchId: string
    mode: 'annotate' | 'true'
    declination: number
  }) => Promise<CorrectionResult>
}

/** 受影响图幅：该批测点所在洞段对应的草图 */
async function affectedSketches(stations: Station[]): Promise<Sketch[]> {
  const segmentIds = new Set(stations.map((station) => station.segmentId))
  const sketches = await syncAll<Sketch>(db.sketches)
  return sketches.filter((sketch) => segmentIds.has(sketch.segmentId))
}

export const batchStore = createStore<BatchState>((set, get) => ({
  batches: [],
  loaded: false,
  hydrate: async () => {
    const batches = await syncAll<SurveyBatch>(db.batches)
    batches.sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.code.localeCompare(b.code))
    set({ batches, loaded: true })
  },
  save: async (batch) => {
    await syncPut<SurveyBatch>(db.batches, batch)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete<SurveyBatch>(db.batches, id)
    await get().hydrate()
  },
  applyCorrection: async ({ batchId, mode, declination }) => {
    const batch = get().batches.find((item) => item.id === batchId)
    if (!batch) {
      return { ok: false, stationCount: 0, sheetPendingCount: 0, sheetKeptCount: 0, mode, message: '找不到该测量批次' }
    }
    if (!Number.isFinite(declination) || Math.abs(declination) > 90) {
      return { ok: false, stationCount: 0, sheetPendingCount: 0, sheetKeptCount: 0, mode, message: '磁偏角必须在 −90°～90° 之间' }
    }

    const allStations = await syncAll<Station>(db.stations)
    const stations = allStations.filter((station) => station.batchId === batchId)
    if (stations.length === 0) {
      return { ok: false, stationCount: 0, sheetPendingCount: 0, sheetKeptCount: 0, mode, message: '该批次下没有测点读数，无法更正' }
    }
    const magneticStations = stations.filter((station) => station.datum === 'magnetic')
    if (mode === 'true' && magneticStations.length === 0) {
      return { ok: false, stationCount: 0, sheetPendingCount: 0, sheetKeptCount: 0, mode, message: '该批次已是真北读数，无需改判' }
    }

    const sketches = await affectedSketches(stations)
    let sheetPendingCount = 0
    let sheetKeptCount = 0
    const reviewedSketches: Sketch[] = []
    for (const sketch of sketches) {
      if (sketch.reviewStatus === 'approved') {
        sheetKeptCount += 1
        continue
      }
      sheetPendingCount += 1
      reviewedSketches.push({ ...sketch, reviewStatus: 'pending' })
    }

    // 整笔事务：任一写入失败则读数与图幅都不落地，可直接按外业班原读数重试
    await db.transaction('rw', db.stations, db.sketches, db.batches, async () => {
      if (mode === 'annotate') {
        // 读数原样保留磁北，仅更新批次/读数上的磁偏角
        const nextBatch: SurveyBatch = { ...batch, datum: 'magnetic', declination }
        await db.batches.put(nextBatch)
        await Promise.all(
          stations.map((station) =>
            station.datum === 'magnetic' ? db.stations.put({ ...station, declination }) : Promise.resolve()
          )
        )
      } else {
        // 整批改判：磁北方位角 + 磁偏角 = 真北方位角，读数重写
        const nextBatch: SurveyBatch = { ...batch, datum: 'true', declination: 0 }
        await db.batches.put(nextBatch)
        await Promise.all(
          magneticStations.map((station) =>
            db.stations.put({
              ...station,
              bearing: magneticToTrue(station.bearing, declination),
              datum: 'true',
              declination: 0
            })
          )
        )
      }
      if (reviewedSketches.length > 0) await db.sketches.bulkPut(reviewedSketches)
    })

    await get().hydrate()
    return {
      ok: true,
      stationCount: mode === 'annotate' ? stations.length : magneticStations.length,
      sheetPendingCount,
      sheetKeptCount,
      mode,
      message:
        mode === 'annotate'
          ? `已补磁偏角 ${declination}°：${stations.length} 站读数保留磁北、出图折真北；${sheetPendingCount} 张图幅转待核，认过保留 ${sheetKeptCount} 张`
          : `已整批改判真北：重写 ${magneticStations.length} 站方位角；${sheetPendingCount} 张图幅转待核，认过保留 ${sheetKeptCount} 张`
    }
  }
}))

/** 新建一个空白批次（外业班开批时用） */
export function draftBatch(caveId: string, code: string): SurveyBatch {
  return {
    id: uid('batch'),
    caveId,
    code,
    datum: 'true',
    declination: 0,
    measuredAt: new Date().toISOString().slice(0, 10),
    note: '',
    createdAt: new Date().toISOString()
  }
}
