<template>
  <section class="page baggage-page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李装卸管理</h2>
        <p class="page-desc">
          按航班与装载舱位归集件数：几个班组各记各的也能一次汇总，提交复核前先看汇总视图，再决定退哪几条。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showForm = !showForm">
          {{ showForm ? '收起登记表单' : '登记行李上报' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出行李装卸清单</button>
      </div>
    </header>

    <div class="rule-banner">
      <strong>装机偏差门禁：</strong>
      实装件数与原始登记（行李计划件数）偏差同时满足「不超过 ±{{ PIECE_TOLERANCE }} 件」且「不超过
      ±2%」才允许确认装机；计划件数未登记、或还有舱位未装载完成的，一并挡回。依据：航班离港须做到舱单与
      实物相符，2 件覆盖个位数挂运/晚到行李，2% 约束大机型不放大绝对容差，两者取严。
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <form v-if="showForm" class="register-form" @submit.prevent="submitRegister">
      <label class="filter-item">
        <span>航班号 *</span>
        <input v-model="form.flight" placeholder="如 MU5102" />
      </label>
      <label class="filter-item">
        <span>装载舱位 *</span>
        <input v-model="form.hold" placeholder="如 1舱" />
      </label>
      <label class="filter-item">
        <span>装卸班组 *</span>
        <input v-model="form.team" placeholder="如 装卸甲组" />
      </label>
      <label class="filter-item">
        <span>传送带编号 *</span>
        <input v-model="form.belt" placeholder="如 BC-01" />
      </label>
      <label class="filter-item">
        <span>行李件数 *</span>
        <input v-model.number="form.pieces" type="number" min="1" step="1" placeholder="正整数" />
      </label>
      <button class="btn primary" type="submit">提交上报（待装载）</button>
      <p class="form-hint">同一航班 + 舱位 + 班组 + 传送带重复上报将被拒收；历史重复数据在下方汇总中自动去重。</p>
    </form>

    <form class="filter-bar" @submit.prevent="reload">
      <label class="filter-item">
        <span>航班号</span>
        <input v-model="flightFilter" placeholder="按航班号筛选汇总视图" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilter">重置条件</button>
    </form>

    <h3 class="section-title">按航班 / 装载舱位汇总（复核先看这张视图）</h3>
    <article v-for="board in boards" :key="board.flight" class="flight-board">
      <header class="board-head">
        <div class="board-title">
          <strong class="flight-name">{{ board.flight }}</strong>
          <span class="board-badge" :class="badgeClass(board.status)">{{ board.status }}</span>
          <span v-if="board.duplicateCount" class="board-badge dedupe">
            去重 {{ board.duplicateCount }} 条重复上报
          </span>
        </div>
        <div class="board-actions">
          <button
            class="btn small"
            type="button"
            :disabled="!board.canSubmit"
            :title="board.canSubmit ? '' : '仍有舱位未装载，或已装机完成'"
            @click="onSubmitFlight(board.flight)"
          >
            提交复核
          </button>
          <button
            class="btn small primary"
            type="button"
            :disabled="!board.canConfirm"
            :title="board.blockReason || '偏差校验通过后才可装机'"
            @click="onConfirmFlight(board.flight)"
          >
            确认装机
          </button>
          <button
            class="btn small warn"
            type="button"
            :disabled="!board.canReturn"
            title="只有待复核的舱位会被退回，已装机舱位不动"
            @click="onReturnFlight(board.flight)"
          >
            整航班退回
          </button>
        </div>
      </header>

      <div class="board-summary">
        <span>原始登记：<strong>{{ board.planCountText }}</strong> 件</span>
        <span>实装（去重后）：<strong>{{ board.loadedCount }}</strong> 件</span>
        <span>装载舱位：<strong>{{ board.holdCount }}</strong> 个</span>
        <span>原始上报：{{ board.rawDetailCount }} 条</span>
        <span :class="deviationClass(board)">
          偏差：
          <strong>{{ board.deviation === null ? '无法核对（计划件数未登记）' : formatSigned(board.deviation) + ' 件' }}</strong>
          <em v-if="board.deviationRate !== null">（{{ (board.deviationRate * 100).toFixed(1) }}%）</em>
        </span>
        <span v-if="board.reviewConclusion" class="board-badge" :class="conclusionClass(board.reviewConclusion)">
          复核结论：{{ board.reviewConclusion }}<template v-if="board.reviewer"> · {{ board.reviewer }}</template>
        </span>
      </div>
      <p v-if="board.blockReason" class="block-reason">⛔ {{ board.blockReason }}</p>

      <table class="data-table hold-table">
        <thead>
          <tr>
            <th>装载舱位</th>
            <th>去重后件数</th>
            <th>上报明细（班组 / 传送带 / 件数 / 状态）</th>
            <th>状态</th>
            <th>退回原因</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cell in board.cells" :key="cell.key" :class="{ 'is-deduped': cell.duplicateCount > 0 }">
            <td>{{ cell.hold }}</td>
            <td><strong>{{ cell.count }}</strong></td>
            <td class="detail-cell">
              <div v-for="row in cell.rows" :key="String(row.id)" class="detail-line kept">
                <span>{{ row['装卸班组'] }} · {{ row['传送带编号'] }} · {{ row['行李件数'] }} 件 · {{ row['上报时间'] }}</span>
                <span class="line-actions">
                  <button
                    v-for="action in rowActions(row.status)"
                    :key="action"
                    class="link"
                    type="button"
                    @click="onRowAction(action, row)"
                  >
                    {{ action }}
                  </button>
                </span>
              </div>
              <div v-for="row in cell.duplicateRows" :key="String(row.id)" class="detail-line duplicate">
                <span>
                  重复上报已折叠：{{ row['装卸班组'] }} · {{ row['传送带编号'] }} · {{ row['行李件数'] }} 件 ·
                  {{ row['作业编号'] }}
                </span>
              </div>
            </td>
            <td><span class="board-badge" :class="badgeClass(cell.status)">{{ cell.status }}</span></td>
            <td>{{ cell.rows[0]['退回原因'] || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </article>
    <p v-if="!boards.length" class="empty-state block-empty">暂无行李上报数据，可先登记一条。</p>

    <h3 class="section-title">原始登记明细（逐班组记账，去重仅作用于汇总件数）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rawRows" :key="String(row.id)" :class="{ 'row-duplicate': duplicateMap.get(Number(row.id)) }">
          <td v-for="column in columns" :key="column">{{ row[column] === '' ? '—' : row[column] }}</td>
          <td>
            {{ row.status }}
            <span v-if="duplicateMap.get(Number(row.id))" class="dup-tag">重复已折叠</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row.status)"
              :key="action"
              class="link"
              type="button"
              @click="onRowAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!rowActions(row.status).length" class="muted-text">终态，无可用动作</span>
          </td>
        </tr>
        <tr v-if="!rawRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无行李上报数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ rawRows.length }} 条原始上报，去重后计入汇总；数据与航班保障待办同源。</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  PIECE_TOLERANCE,
  baggageBoard,
  baggageRows,
  confirmFlight,
  downloadEntries,
  isDuplicateRow,
  listEntries,
  moduleMeta,
  registerBaggage,
  returnFlight,
  runAction as applyAction,
  submitFlight,
} from '@/api/local-service'
import { useSessionStore } from '@/stores/session'
import type { BaggageDetail, BaggageFlightBoard, BaggageStatus, EntryRow } from '@/data/types'

const session = useSessionStore()
const meta = moduleMeta('baggage')
const columns = ['作业编号', '航班号', '行李件数', '装卸班组', '传送带编号', '装载舱位', '复核人员', '上报时间', '退回原因']

const boards = ref<BaggageFlightBoard[]>([])
const rawRows = ref<BaggageDetail[]>([])
const total = ref(0)
const errorMessage = ref('')
const flightFilter = ref('')
const showForm = ref(false)
const form = reactive({ flight: '', hold: '', team: '', belt: '', pieces: undefined as number | undefined })

const duplicateMap = computed(() => {
  const map = new Map<number, boolean>()
  for (const row of rawRows.value) {
    map.set(Number(row.id), isDuplicateRow(row))
  }
  return map
})

const stats = computed(() => {
  const rows = rawRows.value
  const today = new Date().toLocaleDateString('zh-CN')
  return [
    { label: '今日行李作业（原始上报）', value: rows.filter((row) => String(row['上报时间']).includes(today.slice(5))).length || rows.length },
    { label: '装载中 / 待装载', value: rows.filter((row) => row.status === '装载中' || row.status === '待装载').length },
    { label: '待复核作业', value: rows.filter((row) => row.status === '待复核').length },
    { label: '在飞航班数', value: boards.value.length },
    { label: '折叠重复上报', value: boards.value.reduce((sum, board) => sum + board.duplicateCount, 0) },
  ]
})

// 逐级状态机：已装机终态无动作；确认装机只能走航班汇总视图（带偏差门禁），不放在行级。
function rowActions(status: BaggageStatus): string[] {
  if (status === '待装载') {
    return ['开始装载']
  }
  if (status === '装载中') {
    return ['提交复核']
  }
  if (status === '待复核') {
    return ['退回复核']
  }
  return []
}

function badgeClass(status: string): string {
  if (status === '已装机') {
    return 'badge-loaded'
  }
  if (status === '待复核') {
    return 'badge-review'
  }
  if (status === '装载中') {
    return 'badge-loading'
  }
  if (status === '混合') {
    return 'badge-mixed'
  }
  return 'badge-waiting'
}

function conclusionClass(conclusion: string): string {
  if (conclusion === '复核通过已装机') {
    return 'badge-loaded'
  }
  if (conclusion === '复核退回') {
    return 'badge-return'
  }
  return 'badge-review'
}

function deviationClass(board: BaggageFlightBoard): string {
  if (board.deviation === null) {
    return 'deviation-blocked'
  }
  return board.withinTolerance ? 'deviation-ok' : 'deviation-blocked'
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : String(value)
}

function exportRows() {
  downloadEntries(meta.key)
}

function submitRegister() {
  errorMessage.value = ''
  const result = registerBaggage({
    flight: form.flight,
    hold: form.hold,
    team: form.team,
    belt: form.belt,
    pieces: Number(form.pieces),
  })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  form.flight = ''
  form.hold = ''
  form.team = ''
  form.belt = ''
  form.pieces = undefined
  reload()
}

function onRowAction(action: string, row: BaggageDetail) {
  errorMessage.value = ''
  let reason = ''
  if (action === '退回复核') {
    reason = window.prompt(`退回 ${row['作业编号']}（${row['装载舱位']}）的退回原因：`, row['退回原因'] || '') ?? ''
    if (!reason.trim()) {
      errorMessage.value = '已取消：退回复核必须填写原因'
      return
    }
  }
  const result = applyAction(meta.key, Number(row.id), action, reason)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function onSubmitFlight(flight: string) {
  errorMessage.value = ''
  const result = submitFlight(flight)
  if (!result.ok) {
    errorMessage.value = result.message
  }
  reload()
}

function onConfirmFlight(flight: string) {
  errorMessage.value = ''
  const result = confirmFlight(flight, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  window.alert(result.message)
  reload()
}

function onReturnFlight(flight: string) {
  errorMessage.value = ''
  const reason = window.prompt(`整航班「${flight}」退回装载中的原因（已装机舱位保持不动）：`) ?? ''
  if (!reason.trim()) {
    errorMessage.value = '已取消：整航班退回必须填写原因'
    return
  }
  const result = returnFlight(flight, reason, session.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function resetFilter() {
  flightFilter.value = ''
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key)
    rawRows.value = baggageRows()
    total.value = payload.total
    boards.value = baggageBoard(flightFilter.value)
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '行李装卸数据读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.rule-banner {
  background: #fff8e6;
  border: 1px solid #f0c36d;
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 12px;
  color: #7a4a07;
}
.register-form {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 12px;
}
.form-hint {
  flex-basis: 100%;
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}
.section-title {
  font-size: 15px;
  margin: 18px 0 8px;
}
.flight-board {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.board-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.flight-name {
  font-size: 16px;
  margin-right: 8px;
}
.board-badge {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  margin-right: 6px;
  background: #eef2f7;
  color: #334155;
}
.badge-waiting { background: #eef2f7; color: #475569; }
.badge-loading { background: #e0edff; color: #1d4ed8; }
.badge-review { background: #fef3c7; color: #b45309; }
.badge-loaded { background: #dcfce7; color: #15803d; }
.badge-return { background: #fee2e2; color: #b91c1c; }
.badge-mixed { background: #f3e8ff; color: #7e22ce; }
.dedupe { background: #fde8e8; color: #b42318; }
.board-actions { display: flex; gap: 8px; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn.warn { border-color: #d0a0a0; color: #b42318; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.board-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: #475569;
  margin: 10px 0 6px;
}
.deviation-ok { color: #15803d; }
.deviation-blocked { color: #b42318; }
.deviation-blocked em, .deviation-ok em { font-style: normal; margin-left: 2px; }
.block-reason {
  margin: 6px 0;
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: #b42318;
}
.hold-table { margin-top: 8px; }
.detail-cell { line-height: 1.9; }
.detail-line { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
.detail-line.duplicate { color: #b42318; font-size: 12px; text-decoration: line-through; }
.is-deduped { background: #fffafa; }
.block-empty { padding: 16px; }
.dup-tag {
  margin-left: 6px;
  background: #fde8e8;
  color: #b42318;
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 11px;
}
.row-duplicate { color: #94a3b8; }
.muted-text { color: var(--muted); font-size: 12px; }
.line-actions { display: flex; gap: 8px; white-space: nowrap; }
</style>
