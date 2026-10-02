import { createStore } from 'zustand/vanilla'
import type { Sketch } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface SketchState {
  sketches: Sketch[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (sketch: Sketch) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  /** 制图室逐张认过：待核 → 已认过，记录认图人与时间 */
  review: (id: string, reviewer: string) => Promise<void>
  /** 撤回认过：已认过 → 待核（认图有误时用） */
  unreview: (id: string) => Promise<void>
}

export const sketchStore = createStore<SketchState>((set, get) => ({
  sketches: [],
  loaded: false,
  hydrate: async () => {
    const sketches = await syncAll<Sketch>(db.sketches)
    sketches.sort((a, b) => a.mergeOrder - b.mergeOrder)
    set({ sketches, loaded: true })
  },
  save: async (sketch) => {
    await syncPut<Sketch>(db.sketches, sketch)
    await get().hydrate()
  },
  remove: async (id) => {
    await syncDelete(db.sketches, id)
    await get().hydrate()
  },
  reorder: async (orderedIds) => {
    const all = get().sketches
    await Promise.all(
      orderedIds.map((id, index) => {
        const target = all.find((item) => item.id === id)
        return target ? syncPut<Sketch>(db.sketches, { ...target, mergeOrder: index + 1 }) : Promise.resolve()
      })
    )
    await get().hydrate()
  },
  review: async (id, reviewer) => {
    const target = get().sketches.find((item) => item.id === id)
    if (target) {
      await syncPut<Sketch>(db.sketches, {
        ...target,
        reviewStatus: 'approved',
        reviewer: reviewer.trim() || target.author || '制图室',
        reviewedAt: new Date().toISOString()
      })
      await get().hydrate()
    }
  },
  unreview: async (id) => {
    const target = get().sketches.find((item) => item.id === id)
    if (target) {
      await syncPut<Sketch>(db.sketches, { ...target, reviewStatus: 'pending', reviewedAt: '' })
      await get().hydrate()
    }
  }
}))
