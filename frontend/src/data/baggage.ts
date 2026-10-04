/**
 * 行李装载作业的领域层：装载明细、按航班×舱位汇总、偏差闸门、去重、复核待办。
 *
 * 页面只渲染这里算出的结构；状态流转一律在 api/local-service.ts 里改，本文件只放纯计算。
 */
import type { EntryRow } from './types'

// ---- 持久化键：与业务模块平级存放，但不属于 MODULES（不进运营概览的分模块统计）----
export const BAGGAGE_LOAD_KEY = 'baggageLoad' // 装载明细（各班组逐条上报）
export const BAGGAGE_TODO_KEY = 'baggageTodo' // 回写给保障任务的行李复核待办

/** 装载明细状态。重复上报是终态：去重命中后不再计件、不可再流转。 */
export type LoadStatus = '待装载' | '装载中' | '待复核' | '已装机' | '重复上报'

/** 保障待办状态：待复核 / 已退回（需整改后重新提交）/ 已装机（闭环）。 */
export type TodoStatus = '待复核' | '已退回' | '已装机'

export interface LoadRecord {
  id: number
  status: LoadStatus
  pending: boolean
  abnormal: boolean
  作业编号: string
  航班号: string
  装载舱位: string
  传送带编号: string
  装卸班组: string
  装载件数: number
  上报时间: string
  复核人员: string
  退回原因: string
}

export interface TodoRecord {
  id: number
  status: TodoStatus
  pending: boolean
  abnormal: boolean
  航班号: string
  复核结论: string
  实际件数: number
  舱位数: number
  更新时间: string
}

export interface LoadDetail extends LoadRecord {
  /** 去重后是否为该「航班+舱位」保留的那一条；重复上报态恒为 false。 */
  survivor: boolean
}

export interface HoldSummary {
  航班号: string
  装载舱位: string
  件数: number
  明细数: number
  重复数: number
  details: LoadDetail[]
}

export interface FlightLoadSummary {
  航班号: string
  原始登记件数: number
  实际上报件数: number
  舱位数: number
  偏差: number
  容差: number
  允许装机: boolean
  holds: HoldSummary[]
  待复核数: number
  已装机数: number
  重复数: number
}

export const LOAD_STATUSES: LoadStatus[] = ['待装载', '装载中', '待复核', '已装机', '重复上报']

export const HOLD_CHOICES = ['1前舱', '2后舱', '3散货舱', '4尾舱']

/**
 * 件数偏差容差：绝对 2 件，或原始登记件数的 2%，取大者。
 *
 * 依据：窄体机国内航班经济舱托运行李普遍在百件量级，多班组、多舱位分批装卸时，
 * 晚到行李、中转拉卸、行李牌脱落复点造成的 ±1~2 件差异属于现场可由装卸长当场复核消除的
 * 正常波动（参考民航行李运输“装载件数与配载舱单逐舱核对”的惯例，装机前必须分舱清点一致）。
 * 取 max(2, 2%) 意味着：百件以内航班允许 2 件弹性，宽体大航班按 2% 放宽（如 200 件允许 4 件），
 * 超过即视为可能漏装/错装/重复计数，禁止进入已装机，必须退回逐条核对。
 */
export function countTolerance(registered: number): number {
  const base = Number.isFinite(registered) && registered > 0 ? Math.floor(registered) : 0
  return Math.max(2, Math.round(base * 0.02))
}

function toCount(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

export function asLoadRecord(row: EntryRow): LoadRecord {
  return {
    id: Number(row.id),
    status: String(row.status) as LoadStatus,
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    作业编号: String(row['作业编号'] ?? ''),
    航班号: String(row['航班号'] ?? ''),
    装载舱位: String(row['装载舱位'] ?? ''),
    传送带编号: String(row['传送带编号'] ?? ''),
    装卸班组: String(row['装卸班组'] ?? ''),
    装载件数: toCount(row['装载件数']),
    上报时间: String(row['上报时间'] ?? ''),
    复核人员: String(row['复核人员'] ?? ''),
    退回原因: String(row['退回原因'] ?? ''),
  }
}

export function asTodoRecord(row: EntryRow): TodoRecord {
  return {
    id: Number(row.id),
    status: String(row.status) as TodoStatus,
    pending: Boolean(row.pending),
    abnormal: Boolean(row.abnormal),
    航班号: String(row['航班号'] ?? ''),
    复核结论: String(row['复核结论'] ?? ''),
    实际件数: toCount(row['实际件数']),
    舱位数: toCount(row['舱位数']),
    更新时间: String(row['更新时间'] ?? ''),
  }
}

/**
 * 同一「航班 + 装载舱位」的去重规则：
 * 先按传送带编号是否填写完整（完整优先），再按上报时间靠后（晚报覆盖早报），最后按编号大者。
 * 重复上报的记录不计入任何件数，只保留存活的一条。
 */
function pickSurvivor(records: LoadRecord[]): LoadRecord {
  return [...records].sort((a, b) => {
    const beltA = a.传送带编号.trim() ? 1 : 0
    const beltB = b.传送带编号.trim() ? 1 : 0
    if (beltA !== beltB) return beltB - beltA
    const time = String(b.上报时间).localeCompare(String(a.上报时间))
    if (time !== 0) return time
    return b.id - a.id
  })[0]
}

/** 参与计件与状态统计的记录：重复上报终态不参与。 */
export function isLive(record: Pick<LoadRecord, 'status'>): boolean {
  return record.status !== '重复上报'
}

export function dedupeGroups(rows: EntryRow[]): Map<string, LoadRecord[]> {
  const records = rows.map(asLoadRecord)
  const groups = new Map<string, LoadRecord[]>()
  for (const record of records) {
    const key = `${record.航班号}@@${record.装载舱位}`
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(record)
    } else {
      groups.set(key, [record])
    }
  }
  return groups
}

/**
 * 按 航班×舱位 汇总。同舱位存在多条有效上报时，去重后只保留一条计件：
 * 视图里仍列出全部明细，但只有 survivor 一条计入件数。
 */
export function summarizeByHold(rows: EntryRow[]): HoldSummary[] {
  const groups = dedupeGroups(rows)
  const summaries: HoldSummary[] = []
  for (const [, records] of groups) {
    const survivors = records.filter(isLive)
    const duplicates = records.filter((r) => !isLive(r))
    const keeper = survivors.length > 0 ? pickSurvivor(survivors) : undefined
    const details: LoadDetail[] = records
      .sort((a, b) => b.id - a.id)
      .map((record) => ({ ...record, survivor: keeper != null && record.id === keeper.id }))
    summaries.push({
      航班号: (keeper ?? records[0]).航班号,
      装载舱位: (keeper ?? records[0]).装载舱位,
      件数: keeper ? keeper.装载件数 : 0,
      明细数: survivors.length,
      重复数: duplicates.length,
      details,
    })
  }
  return summaries.sort((a, b) =>
    a.航班号 === b.航班号
      ? a.装载舱位.localeCompare(b.装载舱位, 'zh-Hans-CN')
      : a.航班号.localeCompare(b.航班号, 'zh-Hans-CN'),
  )
}

/** 读作业台账（baggage 模块）的原始登记件数，按航班号取一条。 */
export function registeredCountByFlight(jobRows: EntryRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of jobRows) {
    const flight = String(row['航班号'] ?? '')
    if (!flight || map.has(flight)) continue
    map.set(flight, toCount(row['原始登记件数']))
  }
  return map
}

/**
 * 航班级汇总：把舱位汇总卷成「一共几件、分几个舱位」，并对照原始登记件数做偏差闸门判定。
 */
export function summarizeFlights(
  loadRows: EntryRow[],
  jobRows: EntryRow[],
): FlightLoadSummary[] {
  const holds = summarizeByHold(loadRows)
  const registered = registeredCountByFlight(jobRows)
  const byFlight = new Map<string, HoldSummary[]>()
  for (const hold of holds) {
    const bucket = byFlight.get(hold.航班号)
    if (bucket) {
      bucket.push(hold)
    } else {
      byFlight.set(hold.航班号, [hold])
    }
  }

  const flights: FlightLoadSummary[] = []
  for (const [flight, flightHolds] of byFlight) {
    // 只统计有存活明细的舱位；整条舱位都是重复上报时，不占舱位、不计件。
    const liveHolds = flightHolds.filter((hold) => hold.明细数 > 0)
    const actual = liveHolds.reduce((sum, hold) => sum + hold.件数, 0)
    const base = registered.get(flight) ?? 0
    const diff = actual - base
    const tolerance = countTolerance(base)
    const liveDetails = liveHolds.flatMap((hold) => hold.details.filter(isLive))
    flights.push({
      航班号: flight,
      原始登记件数: base,
      实际上报件数: actual,
      舱位数: liveHolds.length,
      偏差: diff,
      容差: tolerance,
      允许装机: base > 0 && Math.abs(diff) <= tolerance,
      holds: flightHolds,
      待复核数: liveDetails.filter((d) => d.status === '待复核').length,
      已装机数: liveDetails.filter((d) => d.status === '已装机').length,
      重复数: flightHolds.reduce((sum, hold) => sum + hold.重复数, 0),
    })
  }
  return flights.sort((a, b) => a.航班号.localeCompare(b.航班号, 'zh-Hans-CN'))
}

/** 保障任务侧同源读取：件数、舱位数与行李作业页完全一致，均由装载明细实时汇总得到。 */
export function flightLoadMap(
  loadRows: EntryRow[],
  jobRows: EntryRow[],
): Map<string, Pick<FlightLoadSummary, '实际上报件数' | '舱位数' | '偏差' | '容差' | '允许装机'>> {
  const map = new Map<string, Pick<FlightLoadSummary, '实际上报件数' | '舱位数' | '偏差' | '容差' | '允许装机'>>()
  for (const summary of summarizeFlights(loadRows, jobRows)) {
    map.set(summary.航班号, {
      实际上报件数: summary.实际上报件数,
      舱位数: summary.舱位数,
      偏差: summary.偏差,
      容差: summary.容差,
      允许装机: summary.允许装机,
    })
  }
  return map
}
