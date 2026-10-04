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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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

    <h3 class="block-title">行李复核待办（与行李装卸页同源，件数按装载明细实时汇总）</h3>
    <p class="source-note">
      待办由行李复核流程回写；行李件数、舱位数不另抄录，均取自行李作业按「航班 × 装载舱位」的同一份汇总，
      偏差超过容差 max(2 件, 2%) 的航班在行李作业页被禁止装机。
    </p>
    <table class="data-table">
      <thead>
        <tr>
          <th>航班号</th>
          <th>行李件数（实装）</th>
          <th>装载舱位数</th>
          <th>对原始登记偏差</th>
          <th>待办状态</th>
          <th>复核结论</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in baggageTodos" :key="todo.航班号">
          <td>{{ todo.航班号 }}</td>
          <td>{{ todo.实际件数 }}</td>
          <td>{{ todo.舱位数 }}</td>
          <td :class="todo.允许装机 ? 'ok-text' : 'error-text'">
            {{ formatDiff(todo.偏差) }} / 容差 ±{{ todo.容差 }}
          </td>
          <td><span class="todo-tag" :class="todoTagClass(todo.状态)">{{ todo.状态 }}</span></td>
          <td>{{ todo.复核结论 }}</td>
          <td>{{ todo.更新时间 || '—' }}</td>
        </tr>
        <tr v-if="!baggageTodos.length">
          <td colspan="7" class="empty-state">暂无行李复核待办</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条航班保障记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listBaggageTodos,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('flight')
const columns = ["保障编号", "航班号", "机型", "计划到达", "机位号", "保障等级", "保障班组", "保障状态"]
const actions = ["接收任务", "开始保障", "确认完成"]
const statuses = ["待接收", "保障中", "保障完成", "已终止"]
const stats = [{"label": "今日保障任务", "value": 0}, {"label": "保障中任务", "value": 0}, {"label": "保障完成率", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const baggageTodos = ref<ReturnType<typeof listBaggageTodos>>([])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function formatDiff(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function todoTagClass(status: string): string {
  if (status === '已装机') return 'tag-ok'
  if (status === '已退回') return 'tag-block'
  return 'tag-warn'
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
    baggageTodos.value = listBaggageTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '航班保障列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.block-title {
  margin: 20px 0 8px;
  font-size: 15px;
}
.source-note {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--muted);
}
.todo-tag {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.tag-ok { background: #e7f6ec; color: #1a7f37; }
.tag-warn { background: #fdf0d9; color: #b25e09; }
.tag-block { background: #fdeaea; color: #b42318; }
.ok-text { color: #1a7f37; }
.error-text { color: #b42318; }
</style>

