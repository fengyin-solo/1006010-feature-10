import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BaggageCell,
  BaggageDetail,
  BaggageFlightBoard,
  BaggageStatus,
  EntryRow,
} from '@/data/types'

// 行李模块 key 与各字段名集中在这里，页面与服务共用一套口径。
export const BAGGAGE_KEY = 'baggage'
export const FLIGHT_KEY = 'flight'

const F_FLIGHT = '航班号'
const F_HOLD = '装载舱位'
const F_TEAM = '装卸班组'
const F_BELT = '传送带编号'
const F_PIECES = '行李件数'
const F_REVIEWER = '复核人员'
const F_REPORTED_AT = '上报时间'
const F_RETURN_REASON = '退回原因'

/**
 * 装机偏差门禁（件数与原始登记的偏差超过此范围就不许进入「已装机」）。
 *
 * 依据：航班离港行李以值机/配载的舱单计划件数为「原始登记」基准，装机完成后
 * 必须做到「舱单与实物相符」才能关闭航班。允许小幅容差是因为短时间挂运、
 * 晚到/迟运行李会造成临时增减，但这类差异必须是个位数、可逐件追溯的：
 *  - 绝对件数最多 2 件：宽体机长航班的挂运/迟到箱通常也控制在 2 件以内，
 *    超出即可能是整舱漏装、错装或传送带分拨错误，不得带疑点装机；
 *  - 相对偏差最多 2%：窄体机（如 100 件）2% 只有 2 件，2 件绝对上限对小机型
 *    已经偏严；该比例约束保证大机型（如 300 件，2%=6 件）不会因为绝对上限
 *    放大成 6 件——此时取 2% 与 2 件中更严的一个。
 * 两条同时满足才放行；计划件数未登记（写没写全没人核）同样挡下，先补齐再复核。
 */
export const PIECE_TOLERANCE = 2
export const RATE_TOLERANCE = 0.02

// 状态机：只允许沿「待装载 → 装载中 → 待复核 → 已装机」逐级流转。
// 越级（含待装载/装载中直接确认装机）一律挡回；已装机为终态，不能再退回待复核。
const ALLOWED_ACTIONS: Record<BaggageStatus, string[]> = {
  待装载: ['开始装载'],
  装载中: ['提交复核', '退回复核'],
  待复核: ['退回复核', '确认装机'],
  已装机: [],
}

const LAST_STATUS: BaggageStatus = '已装机'

function asBaggage(row: EntryRow): BaggageDetail {
  return {
    ...row,
    [F_PIECES]: Number(row[F_PIECES] ?? 0) || 0,
    status: String(row.status) as BaggageStatus,
  } as BaggageDetail
}

export function baggageRows(): BaggageDetail[] {
  return listRows(BAGGAGE_KEY)
    .map(asBaggage)
    .sort((a, b) => String(a[F_FLIGHT]).localeCompare(String(b[F_FLIGHT]), 'zh-Hans-CN'))
}

function persist(rows: BaggageDetail[]): void {
  saveRows(BAGGAGE_KEY, rows as EntryRow[])
}

// 去重键：同一航班 + 同一装载舱位 + 同一装卸班组 + 同一传送带编号视为同一次上报。
// 不同班组各记各的账（题目要求保留），只有完全同源的重复报数才折叠。
function dedupeKey(row: BaggageDetail): string {
  return [F_FLIGHT, F_HOLD, F_TEAM, F_BELT]
    .map((field) => String(row[field] ?? '').trim())
    .join('|')
}

function planCountOf(flight: string): number | null {
  const match = listRows(FLIGHT_KEY).find(
    (row) => String(row[F_FLIGHT] ?? '').trim() === flight.trim(),
  )
  if (!match) {
    return null
  }
  const raw = Number(match['行李计划件数'])
  return Number.isFinite(raw) && raw > 0 ? raw : null
}

function isLoaded(row: BaggageDetail): boolean {
  return row.status === '已装机' || row.status === '待复核'
}

function mixedStatus(rows: BaggageDetail[]): BaggageStatus | '混合' {
  const set = new Set(rows.map((row) => row.status))
  return set.size === 1 ? ([...set][0] as BaggageStatus) : '混合'
}

function withinTolerance(deviation: number, rate: number): boolean {
  return Math.abs(deviation) <= PIECE_TOLERANCE && Math.abs(rate) <= RATE_TOLERANCE
}

/** 按航班与装载舱位归集：同一舱位重复上报去重后只保留一条（保留件数最大的一条）。 */
export function baggageBoard(flightFilter = ''): BaggageFlightBoard[] {
  const filter = flightFilter.trim()
  const flights = new Map<string, BaggageDetail[]>()
  for (const row of baggageRows()) {
    const flight = String(row[F_FLIGHT] ?? '').trim()
    if (filter && !flight.includes(filter)) {
      continue
    }
    const group = flights.get(flight) ?? []
    group.push(row)
    flights.set(flight, group)
  }

  const boards: BaggageFlightBoard[] = []
  for (const [flight, rows] of flights) {
    const cellMap = new Map<string, BaggageDetail[]>()
    for (const row of rows) {
      const key = dedupeKey(row)
      const group = cellMap.get(key) ?? []
      group.push(row)
      cellMap.set(key, group)
    }

    const cells: BaggageCell[] = []
    for (const [key, group] of cellMap) {
      const sorted = [...group].sort((a, b) => Number(b[F_PIECES]) - Number(a[F_PIECES]))
      const kept = sorted[0]
      const duplicates = sorted.slice(1)
      cells.push({
        key,
        flight,
        hold: String(kept[F_HOLD] ?? '').trim(),
        count: Number(kept[F_PIECES]) || 0,
        rawCount: group.reduce((sum, item) => sum + Number(item[F_PIECES] || 0), 0),
        duplicateCount: duplicates.length,
        rows: [kept],
        duplicateRows: duplicates,
        status: mixedStatus(group),
      })
    }
    cells.sort((a, b) => a.hold.localeCompare(b.hold, 'zh-Hans-CN'))

    const deduped = cells.flatMap((cell) => cell.rows)
    const planCount = planCountOf(flight)
    const loadedCount = deduped.filter(isLoaded).reduce((sum, row) => sum + Number(row[F_PIECES]), 0)
    const deviation = planCount === null ? null : loadedCount - planCount
    const deviationRate = planCount ? (deviation ?? 0) / planCount : null

    const hasWaiting = deduped.some((row) => row.status === '待装载')
    const hasReview = deduped.some((row) => row.status === '待复核')
    const allLoaded = deduped.every(isLoaded)
    const allConfirmed = deduped.every((row) => row.status === '已装机')
    const toleranceOk = deviation !== null && deviationRate !== null && withinTolerance(deviation, deviationRate)

    const blockReason = !hasReview
      ? ''
      : !allLoaded
        ? '还有未装载完成的舱位，先装载齐全再复核装机'
        : planCount === null
          ? `航班「${flight}」未登记行李计划件数，原始登记写没写全没人核，补齐后才能装机`
          : !toleranceOk
            ? `实装 ${loadedCount} 件与原始登记 ${planCount} 件偏差 ${deviation} 件（${((deviationRate ?? 0) * 100).toFixed(1)}%），超过 ±${PIECE_TOLERANCE} 件且 ±2% 的允许范围，不许装机`
            : ''

    const flightRow = listRows(FLIGHT_KEY).find(
      (row) => String(row[F_FLIGHT] ?? '').trim() === flight,
    )

    boards.push({
      flight,
      planCount,
      planCountText: planCount === null ? '未登记' : String(planCount),
      loadedCount,
      holdCount: cells.length,
      rawDetailCount: rows.length,
      duplicateCount: cells.reduce((sum, cell) => sum + cell.duplicateCount, 0),
      cells,
      status: mixedStatus(deduped),
      deviation,
      deviationRate,
      withinTolerance: toleranceOk,
      blockReason,
      canSubmit: !hasWaiting && !allConfirmed,
      canConfirm: hasReview && allLoaded && toleranceOk,
      canReturn: hasReview,
      reviewConclusion: String(flightRow?.['行李复核结论'] ?? ''),
      reviewer: String(flightRow?.['复核人员'] ?? ''),
      reviewTime: String(flightRow?.['复核时间'] ?? ''),
      rows,
    })
  }

  return boards.sort((a, b) => a.flight.localeCompare(b.flight, 'zh-Hans-CN'))
}

// 明细带上「是否被去重折叠」的运行时标记，供原始明细列表标注，不改持久化数据。
export function isDuplicateRow(row: BaggageDetail): boolean {
  const key = dedupeKey(row)
  const group = baggageRows().filter((item) => dedupeKey(item) === key)
  if (group.length <= 1) {
    return false
  }
  const kept = [...group].sort((a, b) => Number(b[F_PIECES]) - Number(a[F_PIECES]))[0]
  return kept.id !== row.id
}

function nowText(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

function nextJobNo(rows: BaggageDetail[]): string {
  let max = 2400
  for (const row of rows) {
    const matched = /BAGG-(\d+)/.exec(String(row['作业编号'] ?? ''))
    if (matched) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `BAGG-${String(max + 1).padStart(4, '0')}`
}

export type BaggageDraft = {
  flight: string
  pieces: number
  team: string
  belt: string
  hold: string
}

// 登记一条班组上报；同一舱位的同源重复上报直接拒收（去重前置）。
export function registerBaggage(draft: BaggageDraft): ActionResult {
  const flight = draft.flight.trim()
  const team = draft.team.trim()
  const belt = draft.belt.trim()
  const hold = draft.hold.trim()
  if (!flight || !team || !belt || !hold) {
    return { ok: false, message: '航班号、装卸班组、传送带编号、装载舱位都必须填写' }
  }
  if (!Number.isInteger(draft.pieces) || draft.pieces <= 0) {
    return { ok: false, message: '行李件数必须是大于 0 的整数' }
  }
  const rows = baggageRows()
  const duplicated = rows.find(
    (row) =>
      String(row[F_FLIGHT]).trim() === flight &&
      String(row[F_HOLD]).trim() === hold &&
      String(row[F_TEAM]).trim() === team &&
      String(row[F_BELT]).trim() === belt,
  )
  if (duplicated) {
    return {
      ok: false,
      message: `该班组已通过同一传送带对航班 ${flight} 的 ${hold} 上报过（${duplicated['作业编号']}），同一舱位重复上报只保留一条`,
    }
  }
  const next: BaggageDetail = {
    id: rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1,
    status: '待装载',
    pending: true,
    abnormal: false,
    作业编号: nextJobNo(rows),
    [F_FLIGHT]: flight,
    [F_PIECES]: draft.pieces,
    [F_TEAM]: team,
    [F_BELT]: belt,
    [F_HOLD]: hold,
    [F_REVIEWER]: '',
    [F_REPORTED_AT]: nowText(),
    [F_RETURN_REASON]: '',
  } as BaggageDetail
  persist([...rows, next])
  return { ok: true, message: `已登记 ${next['作业编号']}：${flight} / ${hold} ${draft.pieces} 件，状态「待装载」` }
}

function mutateStatus(row: BaggageDetail, status: BaggageStatus, abnormal: boolean): BaggageDetail {
  const next: BaggageDetail = {
    ...row,
    status,
    pending: status !== LAST_STATUS,
    abnormal,
  }
  if (status === '待复核') {
    next[F_RETURN_REASON] = ''
  }
  return next
}

// 单条动作：严格走状态机，越级挡回；确认装机只能在航班汇总视图做偏差门禁后批量执行。
export function applyBaggageAction(id: number, action: string, reason = ''): ActionResult {
  const rows = baggageRows()
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的行李作业` }
  }
  const row = rows[index]
  if (action === '确认装机') {
    return {
      ok: false,
      message: '不允许单条直接装机：请到按舱位汇总视图完成整航班复核，偏差校验通过后统一「确认装机」',
    }
  }
  if (!ALLOWED_ACTIONS[row.status].includes(action)) {
    if (row.status === '已装机') {
      return { ok: false, message: `${row['作业编号']} 已装机，终态不能再退回待复核或重复操作` }
    }
    return {
      ok: false,
      message: `${row['作业编号']} 当前「${row.status}」，不能执行「${action}」：装载只允许 待装载→装载中→待复核→已装机 逐级流转，越级操作已挡回`,
    }
  }

  let next = row
  if (action === '开始装载') {
    next = mutateStatus(row, '装载中', false)
  } else if (action === '提交复核') {
    next = mutateStatus(row, '待复核', false)
  } else if (action === '退回复核') {
    const note = reason.trim()
    if (!note) {
      return { ok: false, message: '退回复核必须写明退回原因，班组据此整改后重新提交' }
    }
    next = { ...mutateStatus(row, '装载中', true) }
    next[F_RETURN_REASON] = note
  }
  const updated = [...rows]
  updated[index] = next
  persist(updated)
  return { ok: true, message: `${row['作业编号']}已${action}，当前状态「${next.status}」` }
}

function flightRows(): EntryRow[] {
  return listRows(FLIGHT_KEY)
}

// 复核结论回写保障任务待办：件数、舱位数与复核结论都从行李汇总同源取数。
function writeBackFlight(
  flight: string,
  fields: Partial<Record<string, string | number>>,
): ActionResult {
  const flights = flightRows()
  const index = flights.findIndex((row) => String(row[F_FLIGHT] ?? '').trim() === flight.trim())
  if (index < 0) {
    return { ok: false, message: `航班保障任务里找不到「${flight}」，行李复核结论无法回写待办清单` }
  }
  flights[index] = { ...flights[index], ...fields } as EntryRow
  saveRows(FLIGHT_KEY, flights)
  return { ok: true, message: '' }
}

function flightDedupedRows(flight: string): BaggageDetail[] {
  const rows = baggageRows().filter((row) => String(row[F_FLIGHT]).trim() === flight.trim())
  const kept = new Map<string, BaggageDetail>()
  for (const row of rows) {
    const key = dedupeKey(row)
    const current = kept.get(key)
    if (!current || Number(row[F_PIECES]) > Number(current[F_PIECES])) {
      kept.set(key, row)
    }
  }
  return [...kept.values()]
}

// 整航班提交复核：本航班去重后的全部明细必须已经开始装载，否则挡下。
export function submitFlight(flight: string): ActionResult {
  const rows = baggageRows()
  const scoped = flightDedupedRows(flight)
  if (!scoped.length) {
    return { ok: false, message: `航班「${flight}」还没有任何行李上报` }
  }
  const waiting = scoped.filter((row) => row.status === '待装载')
  if (waiting.length) {
    return {
      ok: false,
      message: `还有 ${waiting.length} 条舱位上报未开始装载（${waiting
        .map((row) => `${String(row[F_HOLD])}/${String(row[F_TEAM])}`)
        .join('、')}），装载齐全后才能提交复核`,
    }
  }
  const ids = new Set(scoped.map((row) => row.id))
  const updated = rows.map((row) =>
    ids.has(row.id) && row.status === '装载中' ? mutateStatus(row, '待复核', false) : row,
  )
  persist(updated)

  const loaded = scoped.reduce((sum, row) => sum + Number(row[F_PIECES]), 0)
  const holds = new Set(scoped.map((row) => String(row[F_HOLD]).trim())).size
  writeBackFlight(flight, {
    行李实装件数: loaded,
    行李舱位数: holds,
    行李复核结论: '待复核',
    复核时间: nowText(),
    复核人员: '',
    行李待办: `行李待复核：共 ${loaded} 件 / ${holds} 个舱位，等待复核确认装机`,
  })
  return {
    ok: true,
    message: `航班「${flight}」已提交复核：去重后 ${loaded} 件、${holds} 个舱位，请在汇总视图核对后决定装机或退回`,
  }
}

// 整航班确认装机：必须全部处于待复核且偏差在门禁内，才允许进入已装机。
export function confirmFlight(flight: string, reviewer: string): ActionResult {
  const board = baggageBoard().find((item) => item.flight === flight.trim())
  if (!board) {
    return { ok: false, message: `航班「${flight}」没有行李数据` }
  }
  if (board.cells.every((cell) => cell.rows.every((row) => row.status === '已装机'))) {
    return { ok: false, message: `航班「${flight}」已经装机完成，不用重复确认` }
  }
  if (board.blockReason) {
    return { ok: false, message: board.blockReason }
  }
  const rows = baggageRows()
  const ids = new Set(flightDedupedRows(flight).map((row) => row.id))
  const operator = reviewer.trim() || '复核员'
  const updated = rows.map((row) => {
    if (!ids.has(row.id) || row.status !== '待复核') {
      return row
    }
    const next = mutateStatus(row, '已装机', false)
    next[F_REVIEWER] = operator
    return next
  })
  persist(updated)

  const holds = board.holdCount
  const deviationText =
    board.deviation === null ? '计划件数缺失' : `${board.deviation > 0 ? '+' : ''}${board.deviation} 件`
  writeBackFlight(flight, {
    行李实装件数: board.loadedCount,
    行李舱位数: holds,
    行李复核结论: '复核通过已装机',
    复核时间: nowText(),
    复核人员: operator,
    行李待办: '',
  })
  return {
    ok: true,
    message: `航班「${flight}」复核通过并装机：${board.loadedCount} 件 / ${holds} 个舱位，偏差 ${deviationText}（允许 ±${PIECE_TOLERANCE} 件且 ±2%），结论已回写保障待办`,
  }
}

// 整航班退回：只有待复核的明细退回装载中（已装机的不动，终态不可逆）。
export function returnFlight(flight: string, reason: string, reviewer: string): ActionResult {
  const note = reason.trim()
  if (!note) {
    return { ok: false, message: '整航班退回必须写明退回原因' }
  }
  const rows = baggageRows()
  const ids = new Set(flightDedupedRows(flight).map((row) => row.id))
  let returned = 0
  const updated = rows.map((row) => {
    if (!ids.has(row.id) || row.status !== '待复核') {
      return row
    }
    returned += 1
    const next = mutateStatus(row, '装载中', true)
    next[F_RETURN_REASON] = note
    return next
  })
  if (!returned) {
    return { ok: false, message: `航班「${flight}」没有处于待复核的舱位，无需退回` }
  }
  persist(updated)

  const loaded = flightDedupedRows(flight)
    .filter(isLoaded)
    .reduce((sum, row) => sum + Number(row[F_PIECES]), 0)
  const holds = new Set(flightDedupedRows(flight).map((row) => String(row[F_HOLD]).trim())).size
  writeBackFlight(flight, {
    行李实装件数: loaded,
    行李舱位数: holds,
    行李复核结论: '复核退回',
    复核时间: nowText(),
    复核人员: reviewer.trim() || '复核员',
    行李待办: `行李复核退回：${returned} 条退回装载中整改，原因：${note}`,
  })
  return {
    ok: true,
    message: `航班「${flight}」已退回 ${returned} 条到装载中，已装机舱位保持不动；退回结论已回写保障待办`,
  }
}

export type FlightBaggageTodo = {
  flight: string
  todo: string
  conclusion: string
  abnormal: boolean
}

// 保障任务待办清单读到的行李件数，统一从这里取——与行李页同源。
export function flightBaggageTodos(): FlightBaggageTodo[] {
  return baggageBoard()
    .filter((board) => board.canReturn || board.status === '装载中' || board.status === '待装载' || board.status === '混合')
    .map((board) => {
      const stored = flightRows().find(
        (row) => String(row[F_FLIGHT] ?? '').trim() === board.flight,
      )
      const conclusion = board.reviewConclusion
      if (conclusion === '复核通过已装机') {
        return null
      }
      if (conclusion === '复核退回') {
        return {
          flight: board.flight,
          todo: String(stored?.['行李待办'] ?? `行李复核退回，${board.loadedCount} 件 / ${board.holdCount} 个舱位待整改重报`),
          conclusion,
          abnormal: true,
        }
      }
      if (conclusion === '待复核') {
        return {
          flight: board.flight,
          todo: String(stored?.['行李待办'] ?? ''),
          conclusion,
          abnormal: false,
        }
      }
      return {
        flight: board.flight,
        todo: `行李装载中：已上报 ${board.loadedCount} 件 / ${board.holdCount} 个舱位（原始登记 ${board.planCountText} 件），尚未提交复核`,
        conclusion: '装载中',
        abnormal: false,
      }
    })
    .filter((item): item is FlightBaggageTodo => item !== null)
}
