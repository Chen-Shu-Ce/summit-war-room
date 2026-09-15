/** 施工工序、Gate、與反推採購日期鏈的回歸測試。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../public/js/takeoff/sequence.js';
import { readFile } from 'node:fs/promises';

/* ── 日期工具 ── */

test('工作日與日曆日是不同的函式，不得混用', () => {
  // 2026-09-11 是週五
  assert.equal(S.addWorkdays('2026-09-11', 1), '2026-09-14', '週五 +1 工作日 = 週一');
  assert.equal(S.addDays('2026-09-11', 1), '2026-09-12', '週五 +1 日曆日 = 週六');
  assert.equal(S.addWorkdays('2026-09-14', -1), '2026-09-11');
  assert.equal(S.addWorkdays('2026-09-11', 5), '2026-09-18', '+5 工作日跨一個週末');
});

test('工作日可設定假日', () => {
  const cal = { weekend: [0, 6], holidays: ['2026-09-14'] };
  assert.equal(S.addWorkdays('2026-09-11', 1, cal), '2026-09-15', '週一放假就順延到週二');
});

test('nextWorkday 把週末推到下一個工作日', () => {
  assert.equal(S.nextWorkday('2026-09-12'), '2026-09-14');
  assert.equal(S.nextWorkday('2026-09-14'), '2026-09-14', '本來就是工作日就不動');
});

/* ── 十六類工序識別 ── */

test('十六類工序都能由名稱辨識', () => {
  const cases = [['材料送審', 'submittal'], ['套管預埋', 'sleeve'], ['樓板開孔', 'opening'],
    ['機組基座', 'base'], ['吊架施工', 'hanger'], ['給水主管施工', 'mainPipe'],
    ['排水支管施工', 'branch'], ['衛浴設備安裝', 'equipment'], ['管路試壓', 'pressure'],
    ['絕緣測試', 'insulation'], ['單機測試', 'unitTest'], ['系統測試', 'systemTest'],
    ['聯動測試', 'interlock'], ['隱蔽驗收', 'hiddenAcc'], ['竣工驗收', 'finalAcc']];
  for (const [name, kind] of cases) assert.equal(S.kindOf(name), kind, name);
  assert.equal(S.kindOf('放樣'), 'other');
});

test('測試類與驗收類預設就是 Gate', () => {
  for (const k of ['submittal', 'pressure', 'insulation', 'unitTest', 'systemTest', 'interlock', 'hiddenAcc', 'finalAcc']) {
    assert.equal(S.TASK_KINDS[k].gate, true, k);
  }
  for (const k of ['embed', 'sleeve', 'mainPipe', 'branch']) {
    assert.equal(S.TASK_KINDS[k].gate, false, k);
  }
});

test('預埋類工序預設為隱蔽', () => {
  assert.equal(S.TASK_KINDS.embed.hidden, true);
  assert.equal(S.TASK_KINDS.sleeve.hidden, true);
  assert.equal(S.TASK_KINDS.mainPipe.hidden, false);
});

/* ── 排程 ── */

const T = (code, name, dur, preds = [], extra = {}) => ({
  code, seq: code.split('-')[1], wbs: code.split('-')[0], name, duration: dur,
  preds, kind: S.kindOf(name), ...extra,
});

const CHAIN = [
  T('410-010', '圖說審核', 3),
  T('410-020', '材料送審', 5, [{ code: '410-010', rel: 'FS' }], { isGate: true }),
  T('410-030', '放樣', 2, [{ code: '410-010', rel: 'FS' }]),
  T('410-040', '套管預埋', 4, [{ code: '410-030', rel: 'FS' }]),
  T('410-050', '給水主管施工', 8, [{ code: '410-040', rel: 'FS' }]),
  T('410-060', '支管施工', 6, [{ code: '410-050', rel: 'FS' }]),
  T('410-070', '管路試壓', 2, [{ code: '410-060', rel: 'FS' }], { isGate: true }),
  T('450-010', '衛浴設備安裝', 5, [{ code: '410-070', rel: 'FS' }]),
];

test('正向排程：FS 關聯讓後續工序在前置完成的次一工作日開始', () => {
  const r = S.schedule(CHAIN, { projectStart: '2026-09-14' });
  const by = new Map(r.tasks.map((t) => [t.code, t]));
  assert.equal(by.get('410-010').es, '2026-09-14');
  assert.equal(by.get('410-010').ef, '2026-09-16', '3 個工作日');
  assert.equal(by.get('410-030').es, '2026-09-17', 'FS → 次一工作日');
  assert.equal(by.get('410-040').es, '2026-09-21', '跨週末');
});

test('SS 關聯可同步開始', () => {
  const tasks = [
    T('A-010', '天花吊架施工', 5),
    T('A-020', '機電吊架施工', 5, [{ code: 'A-010', rel: 'SS' }]),
    T('A-030', '後續', 2, [{ code: 'A-020', rel: 'FS' }]),
  ];
  const r = S.schedule(tasks, { projectStart: '2026-09-14' });
  const by = new Map(r.tasks.map((t) => [t.code, t]));
  assert.equal(by.get('A-020').es, by.get('A-010').es, 'SS 應同日開始');
});

test('lag 以工作日計算', () => {
  const tasks = [T('A-010', '養護', 1), T('A-020', '後續', 1, [{ code: 'A-010', rel: 'FS', lag: 3 }])];
  const r = S.schedule(tasks, { projectStart: '2026-09-14' });
  const by = new Map(r.tasks.map((t) => [t.code, t]));
  assert.equal(by.get('A-010').ef, '2026-09-14');
  assert.equal(by.get('A-020').es, '2026-09-18', '完成日 +1 +3 工作日');
});

test('反向排程與浮時：鏈狀工序全部在要徑上', () => {
  const r = S.schedule(CHAIN, { projectStart: '2026-09-14' });
  const by = new Map(r.tasks.map((t) => [t.code, t]));
  assert.equal(by.get('410-050').float, 0);
  assert.ok(r.criticalPath.includes('410-050'));
  // 材料送審是旁支，應有浮時
  assert.ok(by.get('410-020').float > 0, `送審浮時 ${by.get('410-020').float}`);
  assert.ok(!by.get('410-020').critical);
});

test('迴圈相依會被偵測，不會空轉', () => {
  const tasks = [
    T('A-010', 'X', 1, [{ code: 'A-020', rel: 'FS' }]),
    T('A-020', 'Y', 1, [{ code: 'A-010', rel: 'FS' }]),
  ];
  const r = S.schedule(tasks, { projectStart: '2026-09-14' });
  assert.deepEqual(r.cyclic.sort(), ['A-010', 'A-020']);
  assert.ok(r.tasks.every((t) => t.cyclic));
});

test('前置工序不存在時回報而非靜默忽略', () => {
  const r = S.schedule([T('A-010', 'X', 1, [{ code: 'NOPE', rel: 'FS' }])], { projectStart: '2026-09-14' });
  assert.equal(r.missingPreds.length, 1);
  assert.equal(r.missingPreds[0].pred, 'NOPE');
});

/* ── Gate ── */

test('Gate 未通過會擋住所有下游工序', () => {
  const r = S.schedule(CHAIN, { projectStart: '2026-09-14' });
  const blocked = S.gateBlocks(r.tasks);
  assert.ok(blocked.has('450-010'), '試壓未通過應擋住設備安裝');
  const gates = blocked.get('450-010').map((g) => g.code);
  assert.ok(gates.includes('410-070'), JSON.stringify(gates));
  assert.ok(!blocked.has('410-010'), '最前面的工序不該被擋');
});

test('Gate 通過後就不再擋', () => {
  const passed = CHAIN.map((t) => (t.isGate ? { ...t, gateStatus: 'pass' } : t));
  const r = S.schedule(passed, { projectStart: '2026-09-14' });
  assert.equal(S.gateBlocks(r.tasks).size, 0);
});

test('Gate 判定 Fail 一樣擋住', () => {
  const failed = CHAIN.map((t) => (t.code === '410-070' ? { ...t, gateStatus: 'fail' } : t));
  const r = S.schedule(failed, { projectStart: '2026-09-14' });
  assert.ok(S.gateBlocks(r.tasks).has('450-010'));
});

test('Gate 統計', () => {
  const r = S.schedule(CHAIN, { projectStart: '2026-09-14' });
  const g = S.gateSummary(r.tasks);
  assert.equal(g.total, 2);
  assert.equal(g.unchecked, 2);
  assert.ok(g.blocked > 0);
});

/* ── 反推採購鏈（對照你給的範例） ── */

test('反推採購鏈：完全重現範例的五個日期', () => {
  // 範例：需求進場 2026/10/15、Lead 30 天、送審 14 天 → 發包 9/1、PR 8/25
  const task = { code: '410-050', name: '給水主管施工', es: '2026-10-18' };   // 進場緩衝 3 天
  const item = { code: '410.01', leadTimeDays: 30, submittalDays: 14 };
  const c = S.procurementChain(task, item, { siteBufferDays: 3, prToPoDays: 7 });
  assert.equal(c.needOnSite, '2026-10-15', '需求進場日');
  assert.equal(c.approveBy, '2026-09-15', '最晚核准日 = 進場 − Lead 30 天');
  assert.equal(c.submitBy, '2026-09-01', '最晚送審日 = 核准 − 送審 14 天');
  assert.equal(c.poBy, '2026-09-01', '建議發包日');
  assert.equal(c.prBy, '2026-08-25', '建議 PR 日 = 發包 − 內部核決 7 天');
});

test('反推採購鏈：Lead 從送審核准後起算，不是從下單起算', () => {
  const task = { code: 'X', name: 'X', es: '2026-10-18' };
  const c = S.procurementChain(task, { leadTimeDays: 30, submittalDays: 14 }, { siteBufferDays: 3, prToPoDays: 7 });
  // 若 Lead 從下單起算，發包日會是 10/15 − 30 = 9/15，整整差一個送審週期
  assert.notEqual(c.poBy, '2026-09-15');
  assert.equal(S.diffDays(c.poBy, c.approveBy), 14, '發包到核准剛好是送審天數');
  assert.equal(S.diffDays(c.approveBy, c.needOnSite), 30, '核准到進場剛好是 Lead');
});

test('反推採購鏈：逾期與急迫狀態', () => {
  const task = { code: 'X', name: 'X', es: '2026-10-18' };
  const item = { leadTimeDays: 30, submittalDays: 14 };
  assert.equal(S.procurementChain(task, item, { today: '2026-01-01' }).status, 'ok');
  assert.equal(S.procurementChain(task, item, { today: '2026-08-20' }).status, 'urgent');
  assert.equal(S.procurementChain(task, item, { today: '2026-09-30' }).status, 'overdue');
});

test('同一材料被多道工序使用時，由最早那道決定 PR 日', () => {
  const tasks = [
    { code: 'A-010', name: '早', es: '2026-10-01', bomCodes: ['M1'] },
    { code: 'A-020', name: '晚', es: '2026-12-01', bomCodes: ['M1'] },
  ];
  const items = [{ code: 'M1', name: '水管', unit: 'M', leadTimeDays: 30, submittalDays: 14 }];
  const chains = S.materialChains(tasks, items, { siteBufferDays: 3, prToPoDays: 7 });
  assert.equal(chains.length, 1);
  assert.equal(chains[0].taskCode, 'A-010', '最早需要它的工序說了算');
  assert.deepEqual(chains[0].usedBy.sort(), ['A-010', 'A-020']);
});

test('材料鏈依 PR 日排序，最急的排最前', () => {
  const tasks = [
    { code: 'A-010', name: 'a', es: '2026-12-01', bomCodes: ['M1'] },
    { code: 'A-020', name: 'b', es: '2026-10-01', bomCodes: ['M2'] },
  ];
  const items = [
    { code: 'M1', name: 'x', unit: 'M', leadTimeDays: 10 },
    { code: 'M2', name: 'y', unit: 'M', leadTimeDays: 120 },
  ];
  const chains = S.materialChains(tasks, items, {});
  assert.equal(chains[0].itemCode, 'M2', '長交期 + 早需要 → 最急');
});

/* ── 不得把慣例冒充圖說 ── */

const DOCS = [{
  name: '給排水規範.pdf', kind: 'spec',
  text: '第 22 節 給水系統\n管路完成後應辦理管路試壓，試驗壓力 10 kg/cm²，保持 60 分鐘不得洩漏。\n隱蔽前應通知監造辦理隱蔽驗收。',
}];

test('找得到證據才升級為「圖說可證」', () => {
  const tasks = [
    T('410-070', '管路試壓', 2),
    T('410-080', '隱蔽驗收', 1),
    T('410-090', '油漆標示', 2),
  ];
  const out = S.annotateConfidence(tasks, DOCS);
  const by = new Map(out.map((t) => [t.code, t]));
  assert.equal(by.get('410-070').confidence, 'drawing');
  assert.match(by.get('410-070').evidence.text, /試壓/);
  assert.equal(by.get('410-070').evidence.doc, '給排水規範.pdf');
  assert.equal(by.get('410-080').confidence, 'drawing');
  assert.equal(by.get('410-090').confidence, 'suggested', '文件沒提到的工序不得冒充圖說要求');
  assert.equal(by.get('410-090').evidence, null);
});

test('沒有載入任何文件時，全部都是建議工序', () => {
  const out = S.annotateConfidence([T('410-070', '管路試壓', 2)], []);
  assert.equal(out[0].confidence, 'suggested');
  assert.equal(S.CONFIDENCE.suggested.label, '建議工序／需工程確認');
});

/* ── 十六欄輸出 ── */

test('每道工序輸出規定的十六欄', () => {
  const r = S.schedule(CHAIN, { projectStart: '2026-09-14' });
  const items = [{ code: '410.01', name: 'SUS304 3" 水管' }];
  const t = r.tasks.find((x) => x.code === '410-050');
  t.bomCodes = ['410.01']; t.crew = '水電'; t.interfaces = ['土建'];
  t.precondition = '吊架完成、材料送審核准'; t.checkpoint = '自主檢查'; t.sourceDrawing = 'P-410-01';
  const row = S.toRow(t, r.tasks, items);
  assert.equal(S.TASK_COLUMNS.length, 16);
  for (const c of S.TASK_COLUMNS) assert.ok(c.key in row, `缺欄位 ${c.label}`);
  assert.match(row.predText, /410-040/);
  assert.equal(row.relText, 'FS');
  assert.match(row.bomText, /SUS304/);
  assert.match(row.succText, /410-060/);
  assert.equal(row.gateText, '否');
  assert.equal(row.hiddenText, '否');
  assert.equal(row.confidenceText, '建議工序／需工程確認');
});

test('Gate 欄位帶出檢查狀態', () => {
  const r = S.schedule(CHAIN.map((t) => (t.code === '410-070' ? { ...t, gateStatus: 'pass' } : t)), { projectStart: '2026-09-14' });
  const row = S.toRow(r.tasks.find((t) => t.code === '410-070'), r.tasks, []);
  assert.equal(row.gateText, '是（Pass）');
});

/* ── 三種表示 ── */

test('工序樹依 WBS 分組並按 Seq 排序', () => {
  const tree = S.buildTree(CHAIN, new Map([['410', { name: '給水' }], ['450', { name: '衛浴設備' }]]));
  assert.equal(tree.length, 2);
  assert.equal(tree[0].wbs, '410');
  assert.equal(tree[0].name, '給水');
  assert.deepEqual(tree[0].tasks.map((t) => t.seq), ['010', '020', '030', '040', '050', '060', '070']);
});

test('泳道圖依工種分道並算出時間偏移', () => {
  const r = S.schedule(CHAIN.map((t) => ({ ...t, crew: t.wbs === '450' ? '裝修' : '給排水' })), { projectStart: '2026-09-14' });
  const sw = S.buildSwimlanes(r.tasks);
  assert.ok(sw.lanes.length >= 2);
  const names = sw.lanes.map((l) => l.name);
  assert.ok(names.includes('給排水') && names.includes('裝修'));
  const first = sw.lanes.find((l) => l.name === '給排水').tasks[0];
  assert.equal(first.offset, 0, '最早的工序偏移為 0');
  assert.ok(first.length >= 1);
  assert.ok(sw.spanDays > 20);
});

test('辨識優先序：特定構件贏過通用動作', () => {
  assert.equal(S.kindOf('套管預埋'), 'sleeve', '套管是構件，預埋是動作');
  assert.equal(S.kindOf('基座預埋'), 'base');
  assert.equal(S.kindOf('吊架預埋件'), 'hanger');
  assert.equal(S.kindOf('預埋管'), 'embed', '沒有更特定的構件時才歸預埋');
  assert.equal(S.kindOf('隱蔽驗收'), 'hiddenAcc', '不得被「驗收」吃掉');
  assert.equal(S.kindOf('竣工驗收'), 'finalAcc');
  assert.equal(S.kindOf('聯動測試'), 'interlock', '不得被「測試」類混淆');
  assert.ok(S.KIND_PRIORITY.indexOf('sleeve') < S.KIND_PRIORITY.indexOf('embed'));
});

test('送審工序引用 BOM 但不消耗材料 —— 不得當成需求進場日', () => {
  const tasks = [
    { code: 'A-010', name: '冰水主機送審', kind: 'submittal', es: '2026-09-17', bomCodes: ['M1'] },
    { code: 'A-030', name: '冰水主機安裝', kind: 'equipment', es: '2026-10-29', bomCodes: ['M1'] },
  ];
  const items = [{ code: 'M1', name: '冰水主機', unit: '台', leadTimeDays: 180 }];
  const chains = S.materialChains(tasks, items, { siteBufferDays: 3, prToPoDays: 7, submittalDays: 14 });
  assert.equal(chains.length, 1);
  assert.equal(chains[0].taskCode, 'A-030', '需求日應由安裝工序決定，不是送審工序');
  assert.equal(chains[0].needOnSite, '2026-10-26');
  assert.deepEqual(chains[0].submittedBy, ['A-010'], '送審工序仍要留在追溯資訊裡');
  assert.deepEqual(chains[0].usedBy, ['A-030']);
});

test('只被送審引用、沒有消耗工序的材料會被回報而非硬算日期', () => {
  const tasks = [{ code: 'A-010', name: '材料送審', kind: 'submittal', es: '2026-09-17', bomCodes: ['M9'] }];
  const items = [{ code: 'M9', name: '孤兒料', unit: 'M', leadTimeDays: 30 }];
  const chains = S.materialChains(tasks, items, {});
  assert.equal(chains.length, 0);
  assert.equal(chains.orphans.length, 1);
  assert.equal(chains.orphans[0].itemCode, 'M9');
});

test('consumesMaterial：送審不算消耗，其餘都算', () => {
  assert.equal(S.consumesMaterial({ kind: 'submittal' }), false);
  for (const k of ['mainPipe', 'equipment', 'hanger', 'embed', 'other']) {
    assert.equal(S.consumesMaterial({ kind: k }), true, k);
  }
});

/* ────────── 最早可行開工日 ────────── */

test('最早可行開工日：推遲到所有材料的 PR 日都還來得及', async () => {
  const tpl = JSON.parse(await readFile(new URL('../public/data/sequence-template.json', import.meta.url), 'utf8'));
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const tasks = tpl.tasks.map((t) => ({ ...t, kind: S.kindOf(t.name) }));
  const today = '2026-09-13';

  const before = S.materialChains(S.schedule(tasks, { projectStart: '2026-09-14' }).tasks, wbs.items, { today });
  assert.ok(before.some((c) => c.status === 'overdue'), '原本應該有已逾期的材料');

  const f = S.earliestFeasibleStart(tasks, wbs.items, { projectStart: '2026-09-14', today });
  assert.equal(f.feasible, true);
  assert.ok(f.shiftDays > 0, '必須往後推');

  // 用真正的排程重跑一次，確認確實沒有任何一項再逾期
  const after = S.materialChains(S.schedule(tasks, { projectStart: f.earliestStart }).tasks, wbs.items, { today });
  assert.ok(after.length > 0);
  assert.ok(after.every((c) => c.slackDays >= 0), '推遲後不得再有負浮時');
});

test('最早可行開工日：已經來得及時不動開工日', async () => {
  const tpl = JSON.parse(await readFile(new URL('../public/data/sequence-template.json', import.meta.url), 'utf8'));
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const tasks = tpl.tasks.map((t) => ({ ...t, kind: S.kindOf(t.name) }));
  const f = S.earliestFeasibleStart(tasks, wbs.items, { projectStart: '2028-01-03', today: '2026-09-13' });
  assert.equal(f.feasible, true);
  assert.equal(f.shiftDays, 0);
  assert.equal(f.iterations, 0);
});

test('最早可行開工日：推遲量不是把工作日當日曆日線性外插', async () => {
  // 帶國定假日的行事曆下，線性外插會偏早；必須用真排程驗證
  const tpl = JSON.parse(await readFile(new URL('../public/data/sequence-template.json', import.meta.url), 'utf8'));
  const wbs = JSON.parse(await readFile(new URL('../public/data/wbs-template.json', import.meta.url), 'utf8'));
  const tasks = tpl.tasks.map((t) => ({ ...t, kind: S.kindOf(t.name) }));
  const cal = { weekend: [0, 6], holidays: ['2027-02-15', '2027-02-16', '2027-02-17', '2027-02-18', '2027-02-19'] };
  const opts = { projectStart: '2026-09-14', today: '2026-09-13', calendar: cal };
  const f = S.earliestFeasibleStart(tasks, wbs.items, opts);
  assert.equal(f.feasible, true);
  const after = S.materialChains(S.schedule(tasks, { ...opts, projectStart: f.earliestStart }).tasks, wbs.items, opts);
  assert.ok(after.every((c) => c.slackDays >= 0), '含假日的行事曆下也不得有負浮時');
});
