<template>
  <section class="page" data-module="flight">
    <header class="page-head">
      <div>
        <h2>航班保障管理</h2>
        <p class="page-desc">维护航班保障任务，围绕保障编号、航班号、机型、计划到达做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记航班保障任务</button>
        <button class="btn" type="button" @click="exportRows">导出航班保障清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="todo-panel">
      <h3 class="todo-title">行李保障待办（与行李装卸页同源）</h3>
      <p class="todo-note">待复核 / 复核退回 / 仍在装载的航班在这里挂账；件数由行李装卸汇总实时计算，复核结论由行李复核回写。</p>
      <table v-if="todos.length" class="data-table">
        <thead>
          <tr><th>航班号</th><th>行李件数（同源）</th><th>舱位数</th><th>结论</th><th>待办</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in todos" :key="todo.flight" :class="{ 'row-abnormal': todo.abnormal }">
            <td>{{ todo.flight }}</td>
            <td>{{ boardOf(todo.flight)?.loadedCount ?? '—' }}</td>
            <td>{{ boardOf(todo.flight)?.holdCount ?? '—' }}</td>
            <td>
              <span class="conclusion-tag" :class="todo.abnormal ? 'tag-return' : 'tag-review'">{{ todo.conclusion }}</span>
            </td>
            <td>{{ todo.todo }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="todo-empty">暂无行李待办，各班航班行李均已装机或尚未开始上报。</p>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '行李实装件数'">{{ liveLoaded(row) }}</template>
            <template v-else-if="column === '行李舱位数'">{{ liveHolds(row) }}</template>
            <template v-else>{{ displayCell(row, column) }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无航班保障数据，可先登记航班保障任务</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录；「行李实装件数/舱位数」实时取自行李装卸汇总，其余行李字段为复核回写。</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  baggageBoard,
  downloadEntries,
  flightBaggageTodos,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { BaggageFlightBoard, EntryRow } from '@/data/types'
import type { FlightBaggageTodo } from '@/api/local-service'

const meta = moduleMeta('flight')
const columns = ["保障编号", "航班号", "机型", "计划到达", "机位号", "保障等级", "保障班组", "行李计划件数", "行李实装件数", "行李舱位数", "行李复核结论", "复核时间", "复核人员", "行李待办", "保障状态"]
const actions = ["接收任务", "开始保障", "确认完成"]
const statuses = ["待接收", "保障中", "保障完成", "已终止"]
const stats = [{"label": "今日保障任务", "value": 0}, {"label": "保障中任务", "value": 0}, {"label": "保障完成率", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const boards = ref<BaggageFlightBoard[]>([])
const todos = ref<FlightBaggageTodo[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function boardOf(flight: string): BaggageFlightBoard | undefined {
  return boards.value.find((board) => board.flight === flight)
}

// 件数同源：保障侧读到的实装件数必须等于行李装卸汇总视图的去重件数。
function liveLoaded(row: EntryRow): string | number {
  const board = boardOf(String(row['航班号'] ?? ''))
  if (!board || board.loadedCount === 0) {
    return row['行李实装件数'] === '' ? '—' : String(row['行李实装件数'] ?? '—')
  }
  return board.loadedCount
}

function liveHolds(row: EntryRow): string | number {
  const board = boardOf(String(row['航班号'] ?? ''))
  if (!board || board.holdCount === 0) {
    return row['行李舱位数'] === '' ? '—' : String(row['行李舱位数'] ?? '—')
  }
  return board.holdCount
}

function displayCell(row: EntryRow, column: string): string {
  const value = row[column]
  return value === '' || value === undefined || value === null ? '—' : String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '航班保障任务登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    boards.value = baggageBoard()
    todos.value = flightBaggageTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.todo-title { margin: 0 0 4px; font-size: 15px; }
.todo-note { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
.todo-empty { margin: 0; font-size: 13px; color: var(--muted); padding: 8px 0; }
.row-abnormal { background: #fff7f7; }
.conclusion-tag { border-radius: 999px; padding: 2px 10px; font-size: 12px; }
.tag-review { background: #fef3c7; color: #b45309; }
.tag-return { background: #fee2e2; color: #b91c1c; }
</style>
