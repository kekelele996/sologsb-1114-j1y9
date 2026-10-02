<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { BearingDatum, CorrectionResult, ReconcileRow, SurveyBatch } from '@/types'
import { BEARING_DATUM_LABELS } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { batchStore, draftBatch } from '@/stores/batchStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { bearingDelta, bearingToTrue, formatDms, trueBearingOf } from '@/utils/survey'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const batchState = useStore(batchStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')

const dialogVisible = ref(false)
const dialogMode = ref<'create' | 'annotate' | 'true'>('create')
const activeBatchId = ref<string>('')
const dialog = reactive({
  code: '',
  datum: 'true' as BearingDatum,
  declination: 0,
  measuredAt: new Date().toISOString().slice(0, 10),
  note: ''
})
const lastResult = ref<CorrectionResult | null>(null)

watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if ((!selectedCaveId.value || !caveState.caves.some((c) => c.id === selectedCaveId.value)) && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

const caveBatches = computed(() =>
  batchState.batches.filter((batch) => batch.caveId === selectedCaveId.value)
)
const caveSegments = computed(() =>
  segmentState.segments.filter((segment) => segment.caveId === selectedCaveId.value)
)
const segmentCodeOf = (segmentId: string): string =>
  segmentState.segments.find((segment) => segment.id === segmentId)?.code ?? '—'

function stationsOfBatch(batchId: string) {
  return stationState.stations.filter((station) => station.batchId === batchId)
}
function sketchesOfBatch(batchId: string) {
  const segmentIds = new Set(stationsOfBatch(batchId).map((station) => station.segmentId))
  return sketchState.sketches.filter((sketch) => segmentIds.has(sketch.segmentId))
}

function openCreate(): void {
  dialogMode.value = 'create'
  activeBatchId.value = ''
  const next = draftBatch(selectedCaveId.value, `B-${String(caveBatches.value.length + 1).padStart(2, '0')}`)
  dialog.code = next.code
  dialog.datum = next.datum
  dialog.declination = next.declination
  dialog.measuredAt = next.measuredAt
  dialog.note = ''
  dialogVisible.value = true
}

function openCorrection(batch: SurveyBatch, mode: 'annotate' | 'true'): void {
  dialogMode.value = mode
  activeBatchId.value = batch.id
  dialog.code = batch.code
  dialog.datum = batch.datum
  dialog.declination = batch.declination || 0
  dialog.measuredAt = batch.measuredAt
  dialog.note = batch.note
  dialogVisible.value = true
}

const dialogTitle = computed(() => {
  if (dialogMode.value === 'create') return '新建测量批次'
  if (dialogMode.value === 'annotate') return '外业班补磁偏角（读数保留磁北）'
  return '整批改判真北（方位角重写）'
})

async function confirmDialog(): Promise<void> {
  if (dialogMode.value === 'create') {
    if (!dialog.code.trim()) {
      ElMessage.warning('请填写批次编号')
      return
    }
    if (dialog.datum === 'magnetic' && Math.abs(dialog.declination) > 90) {
      ElMessage.warning('磁偏角必须在 −90°～90° 之间')
      return
    }
    const draft = draftBatch(selectedCaveId.value, dialog.code.trim())
    await batchStore.getState().save({
      ...draft,
      datum: dialog.datum,
      declination: dialog.datum === 'magnetic' ? dialog.declination : 0,
      measuredAt: dialog.measuredAt,
      note: dialog.note.trim()
    })
    ElMessage.success(`批次 ${dialog.code} 已建立（${BEARING_DATUM_LABELS[dialog.datum]}）`)
    dialogVisible.value = false
    return
  }

  // 更正前确认：提示影响范围；已认过图幅会保留
  const batch = caveBatches.value.find((item) => item.id === activeBatchId.value)
  if (!batch) return
  const stationCount = stationsOfBatch(batch.id).length
  const approvedCount = sketchesOfBatch(batch.id).filter((sketch) => sketch.reviewStatus === 'approved').length
  const verb = dialogMode.value === 'annotate' ? '补磁偏角' : '整批改判真北'
  await ElMessageBox.confirm(
    `对批次「${batch.code}」${verb}（磁偏角 ${dialog.declination}°）：${stationCount} 站读数将重算，` +
      `未认过的图幅转「待核」由制图室逐张认过；已认过图幅 ${approvedCount} 张保留。更正校验失败可按外业班读数重试。`,
    '基准更正确认',
    { confirmButtonText: '执行更正', cancelButtonText: '取消', type: 'warning' }
  )
  const result = await batchStore.getState().applyCorrection({
    batchId: batch.id,
    mode: dialogMode.value,
    declination: dialog.declination
  })
  if (!result.ok) {
    ElMessage.error(`更正失败：${result.message}（读数未改动，可按外业班读数重试）`)
    return
  }
  lastResult.value = result
  ElMessage.success(result.message)
  dialogVisible.value = false
  // 更正后重新拉取，图幅状态、测点基准都刷新
  await Promise.all([stationStore.getState().hydrate(), sketchStore.getState().hydrate()])
}

/** 跨基准对账：外业班读数 ⇄ 制图室图幅，逐站给出原方位角 / 折真北 / 仍悬磁偏角差 */
const reconcileRows = computed<ReconcileRow[]>(() => {
  const rows: ReconcileRow[] = []
  for (const batch of caveBatches.value) {
    for (const station of stationsOfBatch(batch.id)) {
      const sketch = sketchState.sketches.find((item) => item.segmentId === station.segmentId)
      const trueBearing = trueBearingOf(station)
      rows.push({
        stationId: station.id,
        stationCode: station.code,
        segmentId: station.segmentId,
        segmentCode: segmentCodeOf(station.segmentId),
        sketchId: sketch?.id ?? '',
        sketchCode: sketch?.code ?? '—',
        batchId: batch.id,
        batchCode: batch.code,
        datum: station.datum,
        declination: station.declination,
        rawBearing: station.bearing,
        trueBearing,
        // 磁北读数相对真北仍悬着的角差；真北读数为 0
        delta: station.datum === 'magnetic' ? bearingDelta(bearingToTrue(station.bearing, 'true', 0), trueBearing) : 0
      })
    }
  }
  return rows
})

const pendingCount = computed(
  () =>
    sketchState.sketches.filter(
      (sketch) => sketch.reviewStatus === 'pending' && caveSegments.value.some((segment) => segment.id === sketch.segmentId)
    ).length
)
const approvedCount = computed(
  () =>
    sketchState.sketches.filter(
      (sketch) => sketch.reviewStatus === 'approved' && caveSegments.value.some((segment) => segment.id === sketch.segmentId)
    ).length
)
const magneticStationCount = computed(
  () => reconcileRows.value.filter((row) => row.datum === 'magnetic').length
)
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">方位基准对账（磁北 → 真北）</h2>
        <p class="page-sub">
          外业班按批次保管读数与当时基准，制图室保管草图与图幅锚点；在此跨基准对账，补磁偏角或整批改判真北后，
          闭合差与草图折线按真北重算，图幅转待核由制图室逐张认过，已认过图幅保留。
        </p>
      </div>
      <div class="head-actions">
        <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
          <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
        </el-select>
        <el-button type="primary" @click="openCreate">新建测量批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <el-tag effect="plain">批次 {{ caveBatches.length }} 个</el-tag>
      <el-tag type="warning" effect="plain">磁北读数 {{ magneticStationCount }} 站</el-tag>
      <el-tag type="warning" effect="dark">图幅待核 {{ pendingCount }} 张</el-tag>
      <el-tag type="success" effect="dark">图幅已认过 {{ approvedCount }} 张</el-tag>
    </div>

    <el-alert
      v-if="lastResult"
      class="alert"
      :type="lastResult.ok ? 'success' : 'error'"
      :closable="true"
      @close="lastResult = null"
      :title="lastResult.message"
    />

    <h3 class="section-title">测量批次（外业班：读数 + 当时基准）</h3>
    <el-table :data="caveBatches" border stripe>
      <el-table-column prop="code" label="批次编号" width="100" />
      <el-table-column label="方位基准" width="120">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-tag :type="row.datum === 'magnetic' ? 'warning' : 'success'" size="small" effect="dark">
            {{ BEARING_DATUM_LABELS[row.datum] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="磁偏角" width="110">
        <template #default="{ row }: { row: SurveyBatch }">
          {{ row.datum === 'magnetic' ? `${row.declination}°（东正西负）` : '—' }}
        </template>
      </el-table-column>
      <el-table-column prop="measuredAt" label="测量日期" width="120" />
      <el-table-column label="测点数" width="90">
        <template #default="{ row }: { row: SurveyBatch }">{{ stationsOfBatch(row.id).length }}</template>
      </el-table-column>
      <el-table-column label="关联图幅（待核/认过）" width="170">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-tag size="small" type="warning" effect="plain">
            待核 {{ sketchesOfBatch(row.id).filter((s) => s.reviewStatus === 'pending').length }}
          </el-tag>
          <el-tag size="small" type="success" effect="plain">
            认过 {{ sketchesOfBatch(row.id).filter((s) => s.reviewStatus === 'approved').length }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
      <el-table-column label="基准更正" width="250" fixed="right">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-button
            link
            type="warning"
            size="small"
            :disabled="row.datum !== 'magnetic'"
            @click="openCorrection(row, 'annotate')"
          >
            补磁偏角
          </el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="row.datum !== 'magnetic'"
            @click="openCorrection(row, 'true')"
          >
            整批改判真北
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">两边读数对账（外业班读数 ⇄ 制图室图幅）</h3>
    <el-table :data="reconcileRows" border stripe max-height="380">
      <el-table-column prop="batchCode" label="批次" width="80" />
      <el-table-column prop="segmentCode" label="洞段" width="80" />
      <el-table-column prop="stationCode" label="测点" width="80" />
      <el-table-column label="原始方位角（记录基准）" width="180">
        <template #default="{ row }: { row: ReconcileRow }">
          {{ row.rawBearing.toFixed(2) }}° · {{ formatDms(row.rawBearing) }}
        </template>
      </el-table-column>
      <el-table-column label="基准" width="90">
        <template #default="{ row }: { row: ReconcileRow }">
          <el-tag :type="row.datum === 'magnetic' ? 'warning' : 'success'" size="small" effect="plain">
            {{ BEARING_DATUM_LABELS[row.datum] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="declination" label="磁偏角" width="90">
        <template #default="{ row }: { row: ReconcileRow }">{{ row.datum === 'magnetic' ? `${row.declination}°` : '—' }}</template>
      </el-table-column>
      <el-table-column label="折真北方位角" width="140">
        <template #default="{ row }: { row: ReconcileRow }">
          <span :class="{ shifted: row.datum === 'magnetic' }">{{ row.trueBearing.toFixed(2) }}°</span>
        </template>
      </el-table-column>
      <el-table-column label="仍悬角差" width="110">
        <template #default="{ row }: { row: ReconcileRow }">
          <el-tag v-if="row.datum === 'magnetic'" type="danger" size="small" effect="plain">
            {{ row.delta.toFixed(2) }}°
          </el-tag>
          <span v-else class="ok">已对齐</span>
        </template>
      </el-table-column>
      <el-table-column prop="sketchCode" label="制图室图幅" width="110" />
    </el-table>

    <el-dialog v-model="dialogVisible" :title="dialogTitle" width="460px">
      <el-form label-width="96px">
        <template v-if="dialogMode === 'create'">
          <el-form-item label="批次编号" required>
            <el-input v-model="dialog.code" placeholder="如 B-03" />
          </el-form-item>
          <el-form-item label="方位基准">
            <el-select v-model="dialog.datum" style="width: 100%">
              <el-option label="磁北（罗盘原读数）" value="magnetic" />
              <el-option label="真北（统一基准）" value="true" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="dialog.datum === 'magnetic'" label="磁偏角(°)">
            <el-input-number v-model="dialog.declination" :min="-90" :max="90" :step="0.5" :precision="2" :controls="false" style="width: 100%" />
          </el-form-item>
          <el-form-item label="测量日期">
            <el-date-picker v-model="dialog.measuredAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="dialog.note" type="textarea" :rows="2" />
          </el-form-item>
        </template>
        <template v-else>
          <el-alert
            :type="dialogMode === 'annotate' ? 'warning' : 'primary'"
            :closable="false"
            class="dialog-tip"
            :title="dialogMode === 'annotate'
              ? '补磁偏角：读数保留磁北原值，仅记录磁偏角，出图与闭合差实时折真北。'
              : '整批改判：把磁北方位角重写为真北值（原读数基准置真北，不可见旧磁北值）。'"
          />
          <el-form-item label="批次">
            <el-input :model-value="dialog.code" disabled />
          </el-form-item>
          <el-form-item label="磁偏角(°)" required>
            <el-input-number v-model="dialog.declination" :min="-90" :max="90" :step="0.5" :precision="2" :controls="false" style="width: 100%" />
          </el-form-item>
          <p class="dialog-hint">东偏为正、西偏为负。示例：西偏 2.5° 填 −2.5，则 118.5° 磁方位角 → 116.0° 真方位角。</p>
        </template>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button :type="dialogMode === 'create' ? 'primary' : 'warning'" @click="confirmDialog">
          {{ dialogMode === 'create' ? '建立批次' : '执行更正' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  gap: 8px;
}
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 14px;
}
.alert {
  margin-bottom: 14px;
}
.shifted {
  color: #b8842a;
  font-weight: 600;
}
.ok {
  color: #2f7a55;
  font-size: 12px;
}
.dialog-tip {
  margin-bottom: 12px;
}
.dialog-hint {
  margin: -4px 0 0 96px;
  font-size: 12px;
  color: #8a6d1f;
  line-height: 1.6;
}
</style>
