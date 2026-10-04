import {
  BAGGAGE_LOAD_KEY,
  BAGGAGE_TODO_KEY,
  HOLD_CHOICES,
  LOAD_STATUSES,
  asLoadRecord,
  asTodoRecord,
  countTolerance,
  isLive,
  summarizeFlights,
  type FlightLoadSummary,
  type LoadRecord,
  type LoadStatus,
  type TodoRecord,
} from '@/data/baggage'
import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 行李台账（baggage）的状态不走通用流转：它由装载明细的复核流程驱动，
// 页面只能走本文件里的行李专用动作，防止越级直达已装机。
const DOMAIN_DRIVEN_KEYS = new Set(['baggage'])

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  if (DOMAIN_DRIVEN_KEYS.has(key)) {
    return {
      ok: false,
      message: `行李作业状态由装载复核流程驱动，请在行李作业页按舱位明细操作，不能直接把台账跳到「已装机」`,
    }
  }
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 行李模块的明细与待办要随台账一起回到示例数据，避免半新半旧。
  if (key === 'baggage') {
    resetRows(BAGGAGE_LOAD_KEY)
    resetRows(BAGGAGE_TODO_KEY)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ===========================================================================
// 行李装载作业：明细登记 → 去重 → 提交复核 → 偏差闸门 → 确认装机 / 退回装载
// 复核结论回写保障待办（baggageTodo），台账（baggage）状态随明细流程自动同步。
// ===========================================================================

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function loadRows(): EntryRow[] {
  return listRows(BAGGAGE_LOAD_KEY)
}

function saveLoadRows(rows: EntryRow[]): void {
  saveRows(BAGGAGE_LOAD_KEY, rows)
}

function saveTodoRows(rows: EntryRow[]): void {
  saveRows(BAGGAGE_TODO_KEY, rows)
}

function asEntry(record: LoadRecord): EntryRow {
  return { ...record }
}

export function listBaggageLoads(): LoadRecord[] {
  return loadRows()
    .map(asLoadRecord)
    .sort((a, b) => b.id - a.id)
}

export function baggageFlightSummaries(): FlightLoadSummary[] {
  return summarizeFlights(loadRows(), listRows('baggage'))
}

/** 保障任务侧同源读取：件数/舱位与行李作业页一致，另附该航班的复核待办状态。 */
export function listBaggageTodos(): Array<{
  todo: TodoRecord | null
  航班号: string
  状态: string
  复核结论: string
  实际件数: number
  舱位数: number
  偏差: number
  容差: number
  允许装机: boolean
  更新时间: string
}> {
  const summaries = summarizeFlights(loadRows(), listRows('baggage'))
  const todos = listRows(BAGGAGE_TODO_KEY).map(asTodoRecord)
  const todoByFlight = new Map(todos.map((todo) => [todo.航班号, todo]))

  const flights = new Set(summaries.map((item) => item.航班号))
  for (const todo of todos) {
    flights.add(todo.航班号)
  }

  return [...flights]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((flight) => {
      const summary = summaries.find((item) => item.航班号 === flight)
      const todo = todoByFlight.get(flight) ?? null
      return {
        todo,
        航班号: flight,
        状态: todo?.status ?? '待复核',
        复核结论: todo?.复核结论 ?? '尚未提交复核',
        实际件数: summary?.实际上报件数 ?? 0,
        舱位数: summary?.舱位数 ?? 0,
        偏差: summary?.偏差 ?? 0,
        容差: summary?.容差 ?? countTolerance(0),
        允许装机: summary?.允许装机 ?? false,
        更新时间: todo?.更新时间 ?? '',
      }
    })
}

/** 登记一条装载上报：同一航班只能在其尚未装机时继续上报。 */
export function reportBaggageLoad(input: {
  航班号: string
  装载舱位: string
  传送带编号: string
  装卸班组: string
  装载件数: number
}): ActionResult {
  const 航班号 = input.航班号.trim()
  const 装载舱位 = input.装载舱位.trim()
  const 传送带编号 = input.传送带编号.trim()
  const 装卸班组 = input.装卸班组.trim()
  const 装载件数 = Math.floor(Number(input.装载件数))

  if (!航班号) return fail('请选择要装载的航班')
  if (!装载舱位) return fail('请填写装载舱位')
  if (!传送带编号) return fail('传送带编号是复核必核项，请填写完整')
  if (!装卸班组) return fail('请填写上报的装卸班组')
  if (!Number.isFinite(装载件数) || 装载件数 <= 0) return fail('装载件数必须是大于 0 的整数')
  if (!listRows('baggage').some((row) => String(row['航班号']) === 航班号)) {
    return fail(`航班 ${航班号} 还没有行李作业台账，不能直接登记装载明细`)
  }
  const locked = loadRows().some(
    (row) => String(row['航班号']) === 航班号 && String(row.status) === '已装机',
  )
  if (locked) {
    return fail(`航班 ${航班号} 已有舱位装机完成，已装机记录不允许再补报或退回`)
  }

  const rows = loadRows()
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
  const record: LoadRecord = {
    id: nextId,
    status: '装载中',
    pending: true,
    abnormal: false,
    作业编号: `BLD-${String(nextId).padStart(4, '0')}`,
    航班号,
    装载舱位,
    传送带编号,
    装卸班组,
    装载件数,
    上报时间: nowStamp(),
    复核人员: '',
    退回原因: '',
  }
  saveLoadRows([...rows, asEntry(record)])
  syncFlightJob(航班号)
  return { ok: true, message: `已登记 ${航班号} ${装载舱位} ${装载件数} 件，传送带 ${传送带编号}` }
}

function updateLoad(
  rows: EntryRow[],
  id: number,
  patch: Partial<LoadRecord>,
): { rows: EntryRow[]; record: LoadRecord } | ActionResult {
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) return fail('没有找到这条装载上报')
  const record = asLoadRecord(rows[index])
  const updated: LoadRecord = { ...record, ...patch }
  const next = [...rows]
  next[index] = asEntry(updated)
  return { rows: next, record: updated }
}

/** 待装载的舱位开始装载：只允许 待装载 → 装载中。 */
export function startBaggageLoad(id: number): ActionResult {
  const rows = loadRows()
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) return fail('没有找到这条装载上报')
  if (String(current.status) !== '待装载') {
    return fail(`只有「待装载」的上报才能开始装载，当前是「${current.status}」`)
  }
  const outcome = updateLoad(rows, id, { status: '装载中', pending: true })
  if ('ok' in outcome) return outcome
  saveLoadRows(outcome.rows)
  syncFlightJob(outcome.record.航班号)
  return { ok: true, message: `${outcome.record.航班号} ${outcome.record.装载舱位} 已开始装载` }
}

/**
 * 提交复核前对同舱位重复上报做持久化去重：非存活条目标「重复上报」终态（只留一条），
 * 存活条目置「待复核」。任一存活条目还停在「待装载」则挡下，先完成装载再提交。
 */
export function submitBaggageHold(flight: string, hold: string): ActionResult {
  const records = loadRows()
    .map(asLoadRecord)
    .filter((record) => record.航班号 === flight && record.装载舱位 === hold && isLive(record))
  if (records.length === 0) return fail(`${flight} ${hold} 没有可提交的装载上报`)

  const notLoaded = records.filter((record) => record.status === '待装载')
  if (notLoaded.length > 0) {
    return fail(`${flight} ${hold} 还有 ${notLoaded.length} 条停在「待装载」，完成装载后才能提交复核`)
  }

  const keeper = chooseSurvivor(records)
  const rows = loadRows()
  for (const record of records) {
    const duplicate = record.id !== keeper.id
    const index = rows.findIndex((row) => Number(row.id) === record.id)
    if (index < 0) continue
    const next = asLoadRecord(rows[index])
    rows[index] = asEntry({
      ...next,
      status: duplicate ? '重复上报' : '待复核',
      pending: !duplicate,
      abnormal: duplicate,
      退回原因: duplicate
        ? `与同舱位 ${keeper.作业编号}（${keeper.装卸班组}）重复，去重后保留一条，本条不计件`
        : '',
    })
  }
  saveLoadRows(rows)
  syncFlightJob(flight)
  const dupCount = records.length - 1
  return {
    ok: true,
    message: `${flight} ${hold} 已提交复核：保留 ${keeper.作业编号} ${keeper.装载件数} 件`
      + (dupCount > 0 ? `，${dupCount} 条重复上报已去重不计件` : ''),
  }
}

/** 单条上报直接提交复核：先在同舱位完成去重，再把存活的一条送复核。 */
export function submitBaggageLoad(id: number): ActionResult {
  const target = loadRows().find((row) => Number(row.id) === id)
  if (!target) return fail('没有找到这条装载上报')
  const record = asLoadRecord(target)
  return submitBaggageHold(record.航班号, record.装载舱位)
}

/** 手动去重（提交前预去重）：同舱位只保留一条，其余进「重复上报」终态。 */
export function dedupeBaggageHold(flight: string, hold: string): ActionResult {
  const records = loadRows()
    .map(asLoadRecord)
    .filter((record) => record.航班号 === flight && record.装载舱位 === hold && isLive(record))
  if (records.length < 2) {
    return fail(`${flight} ${hold} 只有一条有效上报，无需去重`)
  }
  const keeper = chooseSurvivor(records)
  const rows = loadRows()
  for (const record of records) {
    if (record.id === keeper.id) continue
    const index = rows.findIndex((row) => Number(row.id) === record.id)
    if (index < 0) continue
    rows[index] = asEntry({
      ...asLoadRecord(rows[index]),
      status: '重复上报',
      pending: false,
      abnormal: true,
      退回原因: `与同舱位 ${keeper.作业编号}（${keeper.装卸班组}）重复，去重后保留一条，本条不计件`,
    })
  }
  saveLoadRows(rows)
  syncFlightJob(flight)
  return { ok: true, message: `${flight} ${hold} 去重完成：保留 ${keeper.作业编号}，${records.length - 1} 条重复上报不计件` }
}

function chooseSurvivor(records: LoadRecord[]): LoadRecord {
  return [...records].sort((a, b) => {
    const beltA = a.传送带编号.trim() ? 1 : 0
    const beltB = b.传送带编号.trim() ? 1 : 0
    if (beltA !== beltB) return beltB - beltA
    const time = b.上报时间.localeCompare(a.上报时间)
    if (time !== 0) return time
    return b.id - a.id
  })[0]
}

/**
 * 复核不通过：待复核 → 装载中（重新清点）。越级与已装机均挡回。
 */
export function rejectBaggageLoad(id: number, reason: string, reviewer: string): ActionResult {
  const rows = loadRows()
  const current = rows.find((row) => Number(row.id) === id)
  if (!current) return fail('没有找到这条装载上报')
  const status = String(current.status)
  if (status === '已装机') {
    return fail('已装机的记录不能再退回待复核/装载，装机闭环不可逆转')
  }
  if (status !== '待复核') {
    return fail(`只有「待复核」的上报才能复核退回，当前是「${status}」`)
  }
  const outcome = updateLoad(rows, id, {
    status: '装载中',
    pending: true,
    abnormal: true,
    复核人员: reviewer.trim() || String(current['复核人员'] ?? ''),
    退回原因: reason.trim() || '复核未通过，退回重新清点',
  })
  if ('ok' in outcome) return outcome
  saveLoadRows(outcome.rows)
  syncFlightJob(outcome.record.航班号)
  return { ok: true, message: `${outcome.record.航班号} ${outcome.record.装载舱位} 已退回装载` }
}

/**
 * 复核通过、确认装机。硬闸门：
 * 1. 该航班全部存活明细必须都在「待复核」——装载中/待装载不得越级到已装机；
 * 2. 分舱件数之和与原始登记件数的偏差必须在容差 max(2, 2%) 内；
 * 任一不满足都挡回，不允许进入已装机。
 */
export function confirmBaggageLoaded(flight: string, reviewer: string): ActionResult {
  const records = loadRows()
    .map(asLoadRecord)
    .filter((record) => record.航班号 === flight && isLive(record))
  if (records.length === 0) return fail(`航班 ${flight} 没有可装机的装载明细`)
  if (records.some((record) => record.status === '已装机')) {
    return fail(`航班 ${flight} 已有舱位装机完成，不能重复确认`)
  }
  const notReady = records.filter((record) => record.status !== '待复核')
  if (notReady.length > 0) {
    const loading = notReady.filter((record) => record.status === '装载中').length
    const waiting = notReady.filter((record) => record.status === '待装载').length
    return fail(
      `越级拦截：${flight} 还有 ${loading} 条装载中、${waiting} 条待装载，`
      + `必须全部提交复核并通过后才能确认装机`,
    )
  }

  const summary = summarizeFlights(loadRows(), listRows('baggage')).find(
    (item) => item.航班号 === flight,
  )
  if (!summary) return fail(`航班 ${flight} 没有行李作业台账`)
  if (!summary.允许装机) {
    return fail(
      `偏差超限拦截：${flight} 原始登记 ${summary.原始登记件数} 件，分舱实装 ${summary.实际上报件数} 件，`
        + `偏差 ${formatDiff(summary.偏差)} 件，超出容差 ±${summary.容差} 件，不许进入已装机；`
        + `请退回相关舱位逐条核对（漏装/错装/重复计数）`,
    )
  }

  const rows = loadRows()
  const operator = reviewer.trim() || '复核员'
  // 装机前最后一道去重：同一舱位有多条存活上报时，非存活条目标重复终态，装机闭环后同舱只留一条。
  const holdGroups = new Map<string, LoadRecord[]>()
  for (const record of records) {
    const key = `${record.航班号}@@${record.装载舱位}`
    const bucket = holdGroups.get(key)
    if (bucket) bucket.push(record)
    else holdGroups.set(key, [record])
  }
  const duplicateIds = new Set<number>()
  for (const group of holdGroups.values()) {
    if (group.length < 2) continue
    const keeper = chooseSurvivor(group)
    for (const record of group) {
      if (record.id !== keeper.id) duplicateIds.add(record.id)
    }
  }
  for (const record of records) {
    const index = rows.findIndex((row) => Number(row.id) === record.id)
    if (index < 0) continue
    if (duplicateIds.has(record.id)) {
      rows[index] = asEntry({
        ...asLoadRecord(rows[index]),
        status: '重复上报',
        pending: false,
        abnormal: true,
        退回原因: `装机复核时与同舱位存活上报重复，去重后只保留一条，本条不计件`,
      })
      continue
    }
    rows[index] = asEntry({ ...asLoadRecord(rows[index]), status: '已装机', pending: false, 复核人员: operator })
  }
  saveLoadRows(rows)
  syncFlightJob(flight, operator)
  return {
    ok: true,
    message: `${flight} 复核通过：${summary.舱位数} 个舱位共 ${summary.实际上报件数} 件，`
      + `偏差 ${formatDiff(summary.偏差)} 在 ±${summary.容差} 内，已装机`,
  }
}

function formatDiff(n: number): string {
  return n > 0 ? `+${n}` : String(n)
}

/**
 * 同步两件事：
 * - 台账（baggage）航班级状态随存活明细自动流转，保证台账不脱离明细；
 * - 复核结论回写保障任务待办（baggageTodo），件数/舱位由明细同源汇总，不另行抄录。
 */
function syncFlightJob(flight: string, reviewer = ''): void {
  const rows = loadRows()
  const records = rows.map(asLoadRecord).filter((record) => record.航班号 === flight && isLive(record))
  const summary = summarizeFlights(loadRows(), listRows('baggage')).find(
    (item) => item.航班号 === flight,
  )

  // 台账状态：全部已装机→已装机；有任一条待复核→待复核；否则→装载中（无明细则待装载）。
  let jobStatus: LoadStatus = '待装载'
  if (records.length > 0) {
    if (records.every((record) => record.status === '已装机')) {
      jobStatus = '已装机'
    } else if (records.some((record) => record.status === '待复核')) {
      jobStatus = '待复核'
    } else {
      jobStatus = '装载中'
    }
  }
  const jobs = listRows('baggage')
  const jobIndex = jobs.findIndex((row) => String(row['航班号']) === flight)
  if (jobIndex >= 0) {
    const nextJobs = [...jobs]
    nextJobs[jobIndex] = {
      ...nextJobs[jobIndex],
      status: jobStatus,
      pending: jobStatus !== '已装机',
      abnormal: records.some((record) => record.abnormal),
      复核人员: reviewer || nextJobs[jobIndex]['复核人员'] || '',
    }
    saveRows('baggage', nextJobs)
  }

  // 待办回写：按最新明细状态给出结论。
  const actual = summary?.实际上报件数 ?? 0
  const holds = summary?.舱位数 ?? 0
  const todos = listRows(BAGGAGE_TODO_KEY)
  const todoIndex = todos.findIndex((row) => String(row['航班号']) === flight)
  let todoStatus: TodoRecord['status'] = '待复核'
  let conclusion = ''
  if (jobStatus === '已装机') {
    todoStatus = '已装机'
    conclusion = `复核通过：${holds} 个舱位，实际 ${actual} 件，偏差 ${formatDiff(summary?.偏差 ?? 0)} 在容差 ±${summary?.容差 ?? 0} 内，已装机`
  } else if (records.some((record) => record.status === '装载中' && record.退回原因)) {
    todoStatus = '已退回'
    const reasons = records
      .filter((record) => record.退回原因)
      .map((record) => `${record.装载舱位}(${record.作业编号})`)
      .join('、')
    conclusion = `复核未通过，${reasons} 已退回装载，整改后重新提交；当前分舱合计 ${actual} 件/${holds} 舱`
  } else if (records.some((record) => record.status === '待复核')) {
    todoStatus = '待复核'
    conclusion = `已提交复核：${holds} 个舱位合计 ${actual} 件，等待复核确认装机`
  } else {
    todoStatus = '待复核'
    conclusion = `装载中：已上报 ${holds} 个舱位、合计 ${actual} 件，尚未提交复核`
  }

  const todoRow: EntryRow = {
    id: todoIndex >= 0 ? Number(todos[todoIndex].id) : todos.length + 1,
    status: todoStatus,
    pending: todoStatus !== '已装机',
    abnormal: todoStatus === '已退回',
    航班号: flight,
    复核结论: conclusion,
    实际件数: actual,
    舱位数: holds,
    更新时间: nowStamp(),
  }
  const nextTodos = todoIndex >= 0 ? [...todos] : [...todos, todoRow]
  if (todoIndex >= 0) nextTodos[todoIndex] = todoRow
  saveTodoRows(nextTodos)
}

export const BAGGAGE_LOAD_STATUSES = LOAD_STATUSES
export const BAGGAGE_HOLD_CHOICES = HOLD_CHOICES

