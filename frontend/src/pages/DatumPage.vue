<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { CorrectionAction, DatumKind, Sketch, SurveyBatch } from '@/types'
import { BATCH_STATUS_LABELS, CORRECTION_ACTION_LABELS, DATUM_LABELS } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { sketchStore } from '@/stores/sketchStore'
import { batchStore, nextBatchCode } from '@/stores/batchStore'
import { DECLINATION_LIMIT, isValidDeclination } from '@/utils/survey'
import { uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const sketchState = useStore(sketchStore)
const batchState = useStore(batchStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const correcting = ref(false)

// IndexedDB 异步水合完成后自动选中第一条洞穴
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

const caveBatches = computed(() => batchState.batches.filter((batch) => batch.caveId === selectedCaveId.value))
const caveSegments = computed(() => segmentState.segments.filter((segment) => segment.caveId === selectedCaveId.value))
const caveSketches = computed(() =>
  sketchState.sketches
    .filter((sketch) => caveSegments.value.some((segment) => segment.id === sketch.segmentId))
    .sort((a, b) => a.mergeOrder - b.mergeOrder)
)
const pendingSketches = computed(() => caveSketches.value.filter((sketch) => sketch.reviewStatus === 'pending'))
const pendingBatches = computed(() => caveBatches.value.filter((batch) => batch.status !== 'ready'))
const caveCorrections = computed(() =>
  batchState.corrections.filter((entry) => entry.caveId === selectedCaveId.value)
)

/** 实际被读数用到的基准种类：两种以上即「两批结果画到一张图上差着磁偏角」 */
const usedDatums = computed<DatumKind[]>(() => {
  const set = new Set<DatumKind>()
  for (const batch of caveBatches.value) {
    if (stationState.stations.some((station) => station.batchId === batch.id)) set.add(batch.datum)
  }
  return [...set]
})
const mixedDatum = computed(() => usedDatums.value.length > 1)
const datumListText = computed(() => usedDatums.value.map((datum) => DATUM_LABELS[datum]).join('、'))

function stationCountOf(batchId: string): number {
  return stationState.stations.filter((station) => station.batchId === batchId).length
}

function dateRangeOf(batchId: string): string {
  const dates = stationState.stations
    .filter((station) => station.batchId === batchId)
    .map((station) => station.date)
    .filter(Boolean)
    .sort()
  if (dates.length === 0) return '—'
  return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} ~ ${dates[dates.length - 1]}`
}

function segmentCodeOf(sketch: Sketch): string {
  return segmentState.segments.find((segment) => segment.id === sketch.segmentId)?.code ?? '未归属'
}

function batchCodeOf(batchId: string): string {
  return batchState.batches.find((batch) => batch.id === batchId)?.code ?? '—'
}

function declinationText(batch: SurveyBatch): string {
  if (batch.datum !== 'magnetic') return '—'
  return batch.declination === null ? '待补' : `${batch.declination}°`
}

function statusTagType(status: SurveyBatch['status']): 'warning' | 'success' | 'danger' {
  if (status === 'ready') return 'success'
  return status === 'pending' ? 'warning' : 'danger'
}

/* ---------- 新建批次 ---------- */

const createDialog = reactive({
  visible: false,
  code: '',
  datum: 'true' as DatumKind,
  declination: undefined as number | undefined,
  keeper: '',
  spanNote: ''
})

function openCreateBatch(): void {
  if (!selectedCaveId.value) {
    ElMessage.warning('请先选择洞穴')
    return
  }
  createDialog.code = nextBatchCode(batchState.batches, selectedCaveId.value)
  createDialog.datum = 'true'
  createDialog.declination = undefined
  createDialog.keeper = caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.surveyor ?? ''
  createDialog.spanNote = ''
  createDialog.visible = true
}

async function submitCreateBatch(): Promise<void> {
  const declination =
    createDialog.datum === 'magnetic' && typeof createDialog.declination === 'number'
      ? createDialog.declination
      : null
  if (declination !== null && !isValidDeclination(declination)) {
    ElMessage.warning(`磁偏角需在 ±${DECLINATION_LIMIT}° 之间`)
    return
  }
  const batch: SurveyBatch = {
    id: uid('batch'),
    caveId: selectedCaveId.value,
    code: createDialog.code.trim() || nextBatchCode(batchState.batches, selectedCaveId.value),
    datum: createDialog.datum,
    declination,
    status: createDialog.datum === 'magnetic' && declination === null ? 'pending' : 'ready',
    keeper: createDialog.keeper.trim(),
    spanNote: createDialog.spanNote.trim(),
    createdAt: new Date().toISOString()
  }
  await batchStore.getState().save(batch)
  createDialog.visible = false
  ElMessage.success(`批次 ${batch.code} 已建立（${DATUM_LABELS[batch.datum]}）`)
}

/* ---------- 基准更正：补磁偏角 / 整批改判真北 ---------- */

const correctDialog = reactive({
  visible: false,
  batch: null as SurveyBatch | null,
  action: 'declination' as CorrectionAction,
  declination: 0,
  operator: ''
})

function openCorrect(batch: SurveyBatch, action: CorrectionAction): void {
  correctDialog.batch = batch
  correctDialog.action = action
  correctDialog.declination = batch.declination ?? 0
  correctDialog.operator =
    batch.keeper || caveState.caves.find((cave) => cave.id === selectedCaveId.value)?.surveyor || ''
  correctDialog.visible = true
}

async function submitCorrection(): Promise<void> {
  const batch = correctDialog.batch
  if (!batch) return
  correcting.value = true
  try {
    const outcome = await batchStore.getState().runCorrection({
      batchId: batch.id,
      action: correctDialog.action,
      declination: correctDialog.action === 'declination' ? Number(correctDialog.declination) : null,
      operator: correctDialog.operator
    })
    if (outcome.ok) {
      ElMessage.success(outcome.message)
      correctDialog.visible = false
    } else {
      // 更正失败：对话框保持打开，外业班修正数值后直接重试
      ElMessage.error(outcome.message)
    }
  } finally {
    correcting.value = false
  }
}

/* ---------- 图幅核认（制图室逐张认过） ---------- */

async function confirmSheet(sketch: Sketch): Promise<void> {
  await sketchStore.getState().setReviewStatus(sketch.id, 'confirmed')
  ElMessage.success(`图幅 ${sketch.code} 已认过`)
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">基准对账与更正</h2>
        <p class="page-sub">
          外业班保管读数与当时的方位角基准，制图室保管草图与图幅锚点；基准不同的读数在此对账。
          外业班补磁偏角或整批改判真北后，闭合差与草图折线按新基准重算，受影响图幅先转待核，由制图室逐张认过。
        </p>
      </div>
      <el-button type="primary" @click="openCreateBatch">
        <el-icon><Plus /></el-icon>新建批次
      </el-button>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 220px">
        <el-option v-for="cave in caveState.caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">批次 {{ caveBatches.length }} 个</el-tag>
      <el-tag v-if="pendingBatches.length > 0" type="warning" effect="plain">
        待处理批次 {{ pendingBatches.length }} 个
      </el-tag>
      <el-tag v-if="mixedDatum" type="danger" effect="dark">基准混用：{{ datumListText }}</el-tag>
      <el-tag v-if="pendingSketches.length > 0" type="warning" effect="plain">
        待核图幅 {{ pendingSketches.length }} 张
      </el-tag>
    </div>

    <el-alert
      v-if="mixedDatum"
      class="alert"
      type="warning"
      :closable="false"
      show-icon
      title="读数基准不一致"
      :description="`该洞穴读数横跨 ${datumListText} 两种基准，画到一张图上会差着磁偏角，洞段折线与图幅拼合将错位。请外业班补录磁偏角或整批改判真北。`"
    />

    <h3 class="section-title">测量批次台账（外业班）</h3>
    <el-table :data="caveBatches" border stripe>
      <el-table-column prop="code" label="批次号" width="100">
        <template #default="{ row }: { row: SurveyBatch }">
          <span class="mono">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="方位角基准" width="110">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-tag :type="row.datum === 'magnetic' ? 'warning' : 'success'" size="small" effect="plain">
            {{ DATUM_LABELS[row.datum] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="磁偏角" width="100">
        <template #default="{ row }: { row: SurveyBatch }">
          <span :class="{ 'pending-text': row.datum === 'magnetic' && row.declination === null }">
            {{ declinationText(row) }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="测点数" width="90">
        <template #default="{ row }: { row: SurveyBatch }">{{ stationCountOf(row.id) }}</template>
      </el-table-column>
      <el-table-column label="读数日期" width="200">
        <template #default="{ row }: { row: SurveyBatch }">{{ dateRangeOf(row.id) }}</template>
      </el-table-column>
      <el-table-column label="批次状态" width="110">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-tag :type="statusTagType(row.status)" size="small" :effect="row.status === 'failed' ? 'dark' : 'plain'">
            {{ BATCH_STATUS_LABELS[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="keeper" label="记录人" width="90" />
      <el-table-column prop="spanNote" label="测回备注" min-width="180" show-overflow-tooltip />
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }: { row: SurveyBatch }">
          <el-button
            link
            type="primary"
            size="small"
            :disabled="row.datum !== 'magnetic'"
            @click="openCorrect(row, 'declination')"
          >
            补磁偏角
          </el-button>
          <el-button
            link
            type="primary"
            size="small"
            :disabled="row.datum !== 'magnetic'"
            @click="openCorrect(row, 'rejudge')"
          >
            改判真北
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">图幅核认（制图室）</h3>
    <el-table :data="caveSketches" border stripe>
      <el-table-column prop="mergeOrder" label="拼合顺序" width="100" />
      <el-table-column prop="code" label="草图编号" width="110">
        <template #default="{ row }: { row: Sketch }">
          <span class="mono">{{ row.code }}</span>
        </template>
      </el-table-column>
      <el-table-column label="洞段" width="100">
        <template #default="{ row }: { row: Sketch }">{{ segmentCodeOf(row) }}</template>
      </el-table-column>
      <el-table-column prop="anchorStake" label="桩号对齐锚点" width="140" />
      <el-table-column label="核认状态" width="100">
        <template #default="{ row }: { row: Sketch }">
          <el-tag :type="row.reviewStatus === 'confirmed' ? 'success' : 'warning'" size="small" effect="plain">
            {{ row.reviewStatus === 'confirmed' ? '认过' : '待核' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reviewNote" label="待核原因" min-width="220" show-overflow-tooltip>
        <template #default="{ row }: { row: Sketch }">
          <span :class="{ muted: !row.reviewNote }">{{ row.reviewNote || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }: { row: Sketch }">
          <el-button
            link
            type="primary"
            size="small"
            :disabled="row.reviewStatus === 'confirmed'"
            @click="confirmSheet(row)"
          >
            认过
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <h3 class="section-title">更正记录</h3>
    <el-table :data="caveCorrections" border stripe>
      <el-table-column label="时间" width="170">
        <template #default="{ row }">{{ row.createdAt.slice(0, 16).replace('T', ' ') }}</template>
      </el-table-column>
      <el-table-column label="批次" width="90">
        <template #default="{ row }">{{ batchCodeOf(row.batchId) }}</template>
      </el-table-column>
      <el-table-column label="动作" width="120">
        <template #default="{ row }">{{ CORRECTION_ACTION_LABELS[row.action as CorrectionAction] }}</template>
      </el-table-column>
      <el-table-column label="磁偏角" width="90">
        <template #default="{ row }">{{ row.declination === null ? '—' : `${row.declination}°` }}</template>
      </el-table-column>
      <el-table-column label="结果" width="90">
        <template #default="{ row }">
          <el-tag :type="row.result === 'success' ? 'success' : 'danger'" size="small" effect="plain">
            {{ row.result === 'success' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="转待核图幅" width="110">
        <template #default="{ row }">{{ row.affectedSheets }} 张</template>
      </el-table-column>
      <el-table-column prop="operator" label="经办" width="100" />
      <el-table-column prop="message" label="说明" min-width="240" show-overflow-tooltip />
    </el-table>

    <el-dialog v-model="createDialog.visible" title="新建测量批次" width="520px">
      <el-form label-width="100px">
        <el-form-item label="批次号" required>
          <el-input v-model="createDialog.code" placeholder="如 B-03" />
        </el-form-item>
        <el-form-item label="方位角基准">
          <el-radio-group v-model="createDialog.datum">
            <el-radio-button value="true">真北</el-radio-button>
            <el-radio-button value="magnetic">磁北</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="createDialog.datum === 'magnetic'" label="磁偏角">
          <el-input-number
            v-model="createDialog.declination"
            :min="-45"
            :max="45"
            :precision="2"
            :step="0.1"
            :controls="false"
            placeholder="留空待补"
            style="width: 160px"
          />
          <span class="muted dialog-hint">东偏为正，合理范围 ±{{ DECLINATION_LIMIT }}°；留空则批次转入「待补磁偏角」</span>
        </el-form-item>
        <el-form-item label="记录人">
          <el-input v-model="createDialog.keeper" placeholder="外业班记录人" />
        </el-form-item>
        <el-form-item label="测回备注">
          <el-input v-model="createDialog.spanNote" type="textarea" :rows="2" placeholder="测回时间、仪器、基准来源等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="createDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitCreateBatch">建立批次</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="correctDialog.visible"
      :title="`基准更正：${correctDialog.batch?.code ?? ''} · ${CORRECTION_ACTION_LABELS[correctDialog.action]}`"
      width="520px"
    >
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="dialog-alert"
        :title="
          correctDialog.action === 'declination'
            ? '补录磁偏角后，本批磁北读数将按 真北方位 = 读数 + 磁偏角 归算。'
            : '整批改判真北后，本批读数直接按真北方位使用，不再补磁偏角。'
        "
        description="更正成功后闭合差与草图折线按新基准重算，受影响图幅转待核（已认过的图幅保留）；更正失败可修正后重试。"
      />
      <el-form label-width="100px">
        <el-form-item v-if="correctDialog.action === 'declination'" label="磁偏角" required>
          <el-input-number
            v-model="correctDialog.declination"
            :min="-45"
            :max="45"
            :precision="2"
            :step="0.1"
            :controls="false"
            style="width: 160px"
          />
          <span class="muted dialog-hint">东偏为正，合理范围 ±{{ DECLINATION_LIMIT }}°</span>
        </el-form-item>
        <el-form-item label="经办">
          <el-input v-model="correctDialog.operator" placeholder="外业班经办人" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="correctDialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="correcting" @click="submitCorrection">确认更正</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.alert {
  margin-bottom: 12px;
}
.pending-text {
  color: #b8860b;
  font-weight: 600;
}
.dialog-hint {
  margin-left: 10px;
}
.dialog-alert {
  margin-bottom: 14px;
}
</style>
