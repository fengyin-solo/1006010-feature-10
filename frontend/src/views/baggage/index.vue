<template>
  <section class="page" data-module="baggage">
    <header class="page-head">
      <div>
        <h2>行李装卸管理</h2>
        <p class="page-desc">
          装载按航班与装载舱位归集件数，同舱位重复上报去重后只保留一条；提交复核前一次看清总件数与分舱明细，
          件数偏差超过容差 max(2 件, 2%) 不许进入已装机。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记装载上报</button>
        <button class="btn" type="button" @click="exportRows">导出行李台账</button>
        <button class="btn ghost" type="button" @click="resetAll">重置示例数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <h3 class="block-title">按航班与装载舱位汇总（复核先看这张视图）</h3>
    <div v-for="flight in flights" :key="flight.航班号" class="flight-card" :class="{ blocked: !flight.允许装机 && flight.待复核数 > 0 }">
      <div class="flight-head">
        <div class="flight-title">
          <strong>{{ flight.航班号 }}</strong>
          <span class="tag" :class="jobTagClass(flight.航班号)">{{ jobStatus(flight.航班号) }}</span>
          <span class="tag" v-if="flight.重复数 > 0">重复去重 {{ flight.重复数 }} 条</span>
        </div>
        <div class="flight-metrics">
          <span>原始登记 <b>{{ flight.原始登记件数 }}</b> 件</span>
          <span>分舱实装 <b>{{ flight.实际上报件数 }}</b> 件</span>
          <span>装载舱位 <b>{{ flight.舱位数 }}</b> 个</span>
          <span>
            偏差
            <b :class="flight.允许装机 ? 'ok-text' : 'error-text'">
              {{ formatDiff(flight.偏差) }}
            </b>
            / 容差 ±{{ flight.容差 }}
          </span>
          <span class="tag" :class="flight.允许装机 ? 'tag-ok' : 'tag-block'">
            {{ flight.允许装机 ? '偏差达标可装机' : '超差禁装机' }}
          </span>
        </div>
      </div>

      <table class="data-table hold-table">
        <thead>
          <tr>
            <th>装载舱位</th>
            <th>件数（去重后）</th>
            <th>上报明细</th>
            <th>传送带</th>
            <th>装卸班组</th>
            <th>上报时间</th>
            <th>舱位状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="hold in flight.holds" :key="`${flight.航班号}-${hold.装载舱位}`">
            <tr
              v-for="(detail, index) in hold.details"
              :key="detail.id"
              :class="{
                'dup-row': !detail.survivor,
                'first-of-hold': index === 0,
              }"
            >
              <td v-if="index === 0" :rowspan="hold.details.length" class="hold-cell">
                {{ hold.装载舱位 }}
                <div class="hold-count">合计 {{ hold.件数 }} 件</div>
                <div v-if="hold.重复数 > 0" class="dup-hint">另有 {{ hold.重复数 }} 条重复不计</div>
              </td>
              <td>{{ detail.survivor ? `${detail.装载件数} 件` : '—' }}</td>
              <td>
                {{ detail.作业编号 }}
                <span v-if="!detail.survivor" class="tag tag-dup">重复上报</span>
                <span v-else-if="hold.details.length > 1" class="tag tag-keep">去重保留</span>
                <div v-if="detail.退回原因" class="reason-text">退回：{{ detail.退回原因 }}</div>
              </td>
              <td>{{ detail.传送带编号 || '—' }}</td>
              <td>{{ detail.装卸班组 }}</td>
              <td>{{ detail.上报时间 }}</td>
              <td>
                <span class="tag" :class="statusTagClass(detail.status)">{{ detail.status }}</span>
              </td>
              <td class="row-actions">
                <button v-if="detail.status === '待装载'" class="link" type="button" @click="doAction(() => startBaggageLoad(detail.id))">
                  开始装载
                </button>
                <button
                  v-if="detail.status === '装载中' || detail.status === '待装载'"
                  class="link"
                  type="button"
                  @click="doAction(() => submitBaggageLoad(detail.id))"
                >
                  提交复核
                </button>
                <button
                  v-if="detail.survivor && (detail.status === '装载中' || detail.status === '待装载') && liveCount(hold) >= 2"
                  class="link"
                  type="button"
                  @click="doAction(() => dedupeBaggageHold(detail.航班号, detail.装载舱位))"
                >
                  按舱位去重
                </button>
                <button v-if="detail.status === '待复核'" class="link danger" type="button" @click="openReject(detail)">
                  退回装载
                </button>
                <span v-if="detail.status === '已装机'" class="muted-text">装机闭环</span>
                <span v-if="!detail.survivor" class="muted-text">不计件</span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <div class="flight-foot">
        <span class="muted-text">
          待复核 {{ flight.待复核数 }} 条 · 已装机 {{ flight.已装机数 }} 条 ·
          全部存活明细到「待复核」后才能确认装机
        </span>
        <button
          class="btn primary"
          type="button"
          :disabled="!canConfirm(flight)"
          :title="confirmTitle(flight)"
          @click="doAction(() => confirmBaggageLoaded(flight.航班号, '王复'))"
        >
          确认装机（{{ flight.实际上报件数 }} 件 / {{ flight.舱位数 }} 舱）
        </button>
      </div>
    </div>

    <h3 class="block-title">行李作业台账（件数以装载明细同源汇总为准）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in jobColumns" :key="column">{{ column }}</th>
          <th>分舱实装件数</th>
          <th>舱位数</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="job in jobs" :key="String(job.id)">
          <td v-for="column in jobColumns" :key="column">{{ job[column] || '—' }}</td>
          <td>{{ jobLive(job['航班号']).实际 }}</td>
          <td>{{ jobLive(job['航班号']).舱位 }}</td>
          <td><span class="tag" :class="statusTagClass(String(job.status))">{{ job.status }}</span></td>
        </tr>
      </tbody>
    </table>

    <!-- 登记上报 -->
    <div v-if="creating" class="modal-mask" @click.self="creating = false">
      <form class="modal" @submit.prevent="submitCreate">
        <h4>登记装载上报</h4>
        <p class="muted-text">同一航班同一舱位重复上报，复核前会自动去重，只保留传送带编号完整、上报时间靠后的一条。</p>
        <label class="form-item">
          <span>航班号</span>
          <select v-model="form.航班号">
            <option value="" disabled>选择航班</option>
            <option v-for="job in jobs" :key="String(job.id)" :value="String(job['航班号'])">
              {{ job['航班号'] }}（登记 {{ job['原始登记件数'] }} 件）
            </option>
          </select>
        </label>
        <label class="form-item">
          <span>装载舱位</span>
          <input v-model="form.装载舱位" list="hold-choices" placeholder="如 1前舱" />
          <datalist id="hold-choices">
            <option v-for="choice in holdChoices" :key="choice" :value="choice" />
          </datalist>
        </label>
        <label class="form-item">
          <span>传送带编号</span>
          <input v-model="form.传送带编号" placeholder="如 B-03" />
        </label>
        <label class="form-item">
          <span>装卸班组</span>
          <input v-model="form.装卸班组" placeholder="如 装卸甲班" />
        </label>
        <label class="form-item">
          <span>本舱装载件数</span>
          <input v-model.number="form.装载件数" type="number" min="1" step="1" />
        </label>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="creating = false">取消</button>
          <button class="btn primary" type="submit">登记上报</button>
        </div>
      </form>
    </div>

    <!-- 复核退回 -->
    <div v-if="rejecting" class="modal-mask" @click.self="rejecting = null">
      <form class="modal" @submit.prevent="submitReject">
        <h4>复核退回：{{ rejecting.航班号 }} {{ rejecting.装载舱位 }}</h4>
        <p class="muted-text">退回后该条回到「装载中」，复核结论会同步写回保障任务的行李待办清单。</p>
        <label class="form-item">
          <span>复核人员</span>
          <input v-model="rejectForm.复核人员" placeholder="如 王复" />
        </label>
        <label class="form-item">
          <span>退回原因</span>
          <textarea v-model="rejectForm.原因" rows="3" placeholder="如 后舱点数与传送带记录不符，重新清点"></textarea>
        </label>
        <p v-if="rejectError" class="error-text">{{ rejectError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="rejecting = null">取消</button>
          <button class="btn primary" type="submit">确认退回装载</button>
        </div>
      </form>
    </div>

    <footer class="page-foot">
      <span>共 {{ loads.length }} 条装载上报，已装机记录不可再退回待复核</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  BAGGAGE_HOLD_CHOICES,
  confirmBaggageLoaded,
  dedupeBaggageHold,
  downloadEntries,
  listBaggageLoads,
  baggageFlightSummaries,
  rejectBaggageLoad,
  reportBaggageLoad,
  resetModule,
  startBaggageLoad,
  submitBaggageLoad,
} from '@/api/local-service'
import type { FlightLoadSummary, LoadDetail, LoadRecord } from '@/data/baggage'
import { listEntries, moduleMeta } from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('baggage')
const jobColumns = ['作业编号', '航班号', '原始登记件数', '装卸班组', '复核人员']
const holdChoices = BAGGAGE_HOLD_CHOICES

const loads = ref<LoadRecord[]>([])
const flights = ref<FlightLoadSummary[]>([])
const jobs = ref<EntryRow[]>([])
const errorMessage = ref('')

const stats = computed(() => {
  const loading = loads.value.filter((item) => item.status === '装载中' || item.status === '待装载').length
  const reviewing = loads.value.filter((item) => item.status === '待复核').length
  const dup = loads.value.filter((item) => item.status === '重复上报').length
  return [
    { label: '装载上报总数', value: loads.value.length },
    { label: '装载中/待装载', value: loading },
    { label: '待复核明细', value: reviewing },
    { label: '重复去重', value: dup },
  ]
})

function reload() {
  errorMessage.value = ''
  try {
    loads.value = listBaggageLoads()
    flights.value = baggageFlightSummaries()
    jobs.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '行李作业数据读取失败'
  }
}

onMounted(reload)

function doAction(fn: () => { ok: boolean; message: string }) {
  errorMessage.value = ''
  const result = fn()
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function liveCount(hold: FlightLoadSummary['holds'][number]): number {
  return hold.details.filter((detail) => detail.status !== '重复上报').length
}

function liveDetailCount(flight: FlightLoadSummary): number {
  return flight.holds.reduce((sum, hold) => sum + liveCount(hold), 0)
}

function canConfirm(flight: FlightLoadSummary): boolean {
  return flight.待复核数 > 0 && flight.待复核数 === liveDetailCount(flight) && flight.允许装机
}

function confirmTitle(flight: FlightLoadSummary): string {
  if (flight.待复核数 === 0 || flight.待复核数 !== liveDetailCount(flight)) {
    return '须全部存活明细提交复核后才能装机'
  }
  return flight.允许装机 ? '' : '件数偏差超过容差，禁止装机，请退回相关舱位核对'
}

function jobStatus(flight: string): string {
  return String(jobs.value.find((job) => String(job['航班号']) === flight)?.status ?? '待装载')
}

function jobLive(flight: unknown): { 实际: number; 舱位: number } {
  const summary = flights.value.find((item) => item.航班号 === String(flight))
  return { 实际: summary?.实际上报件数 ?? 0, 舱位: summary?.舱位数 ?? 0 }
}

function formatDiff(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

function statusTagClass(status: string): string {
  if (status === '已装机') return 'tag-ok'
  if (status === '待复核') return 'tag-warn'
  if (status === '重复上报') return 'tag-dup'
  if (status === '待装载') return 'tag-idle'
  return ''
}

function jobTagClass(flight: string): string {
  return statusTagClass(jobStatus(flight))
}

// ---- 登记 ----
const creating = ref(false)
const formError = ref('')
const form = reactive({ 航班号: '', 装载舱位: '', 传送带编号: '', 装卸班组: '', 装载件数: 0 })

function openCreate() {
  form.航班号 = ''
  form.装载舱位 = ''
  form.传送带编号 = ''
  form.装卸班组 = ''
  form.装载件数 = 0
  formError.value = ''
  creating.value = true
}

function submitCreate() {
  formError.value = ''
  const result = reportBaggageLoad({ ...form })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  creating.value = false
  reload()
}

// ---- 退回 ----
const rejecting = ref<LoadRecord | null>(null)
const rejectError = ref('')
const rejectForm = reactive({ 复核人员: '', 原因: '' })

function openReject(detail: LoadDetail) {
  rejecting.value = detail
  rejectForm.复核人员 = detail.复核人员 || ''
  rejectForm.原因 = ''
  rejectError.value = ''
}

function submitReject() {
  if (!rejecting.value) return
  rejectError.value = ''
  const result = rejectBaggageLoad(rejecting.value.id, rejectForm.原因, rejectForm.复核人员)
  if (!result.ok) {
    rejectError.value = result.message
    return
  }
  rejecting.value = null
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetAll() {
  resetModule(meta.key)
  reload()
}
</script>

<style scoped>
.block-title {
  margin: 18px 0 10px;
  font-size: 15px;
}
.flight-card {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 14px;
}
.flight-card.blocked {
  border-color: #f0a8a0;
}
.flight-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}
.flight-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}
.flight-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 13px;
  color: var(--muted);
}
.flight-metrics b {
  color: #1f2937;
}
.hold-table {
  border-radius: 6px;
  overflow: hidden;
}
.hold-cell {
  background: #f8fafc;
  font-weight: 600;
  vertical-align: top;
}
.hold-count {
  font-weight: 400;
  color: var(--muted);
  font-size: 12px;
  margin-top: 2px;
}
.dup-hint {
  font-weight: 400;
  color: #b42318;
  font-size: 12px;
  margin-top: 2px;
}
.dup-row {
  background: #fdf3f2;
  color: var(--muted);
}
.reason-text {
  color: #b42318;
  font-size: 12px;
  margin-top: 2px;
}
.flight-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 10px;
}
.tag {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 10px;
  font-size: 12px;
  background: #eef2f7;
  color: var(--muted);
}
.tag-ok { background: #e7f6ec; color: #1a7f37; }
.tag-warn { background: #fdf0d9; color: #b25e09; }
.tag-block { background: #fdeaea; color: #b42318; }
.tag-dup { background: #f3e8ff; color: #7e22ce; }
.tag-idle { background: #eef2f7; color: var(--muted); }
.ok-text { color: #1a7f37; }
.muted-text { color: var(--muted); font-size: 12px; }
.link.danger { color: #b42318; }
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal {
  width: 420px;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.modal h4 {
  margin: 0 0 6px;
}
.form-item {
  display: block;
  margin: 10px 0;
  font-size: 13px;
  color: var(--muted);
}
.form-item span {
  display: block;
  margin-bottom: 4px;
}
.form-item input,
.form-item select,
.form-item textarea {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
</style>
