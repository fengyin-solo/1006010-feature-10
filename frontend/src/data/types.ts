/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ===== 行李装卸：按航班 + 装载舱位汇总的领域模型 =====

export type BaggageStatus = '待装载' | '装载中' | '待复核' | '已装机'

// 一条班组上报的行李明细（一个装卸班组在一条传送带上对一个舱位的一次上报）。
export type BaggageDetail = EntryRow & {
  作业编号: string
  航班号: string
  行李件数: number
  装卸班组: string
  传送带编号: string
  装载舱位: string
  复核人员: string
  上报时间: string
  退回原因: string
  status: BaggageStatus
}

// 一个「航班 + 装载舱位」格子：去重后的件数与明细一次列出。
export type BaggageCell = {
  key: string
  flight: string
  hold: string
  count: number
  rawCount: number
  duplicateCount: number
  rows: BaggageDetail[]
  duplicateRows: BaggageDetail[]
  status: BaggageStatus | '混合'
}

// 一张按航班排列的汇总视图：提交复核前先看它再决定退哪几条。
export type BaggageFlightBoard = {
  flight: string
  planCount: number | null
  planCountText: string
  loadedCount: number
  holdCount: number
  rawDetailCount: number
  duplicateCount: number
  cells: BaggageCell[]
  status: BaggageStatus | '混合'
  deviation: number | null
  deviationRate: number | null
  withinTolerance: boolean
  blockReason: string
  canSubmit: boolean
  canConfirm: boolean
  canReturn: boolean
  reviewConclusion: string
  reviewer: string
  reviewTime: string
  rows: BaggageDetail[]
}
