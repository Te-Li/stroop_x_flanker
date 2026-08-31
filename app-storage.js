(function () {
  'use strict';

  const DB_NAME = 'cognitive-experiment-platform';
  const DB_VERSION = 2;
  const STORE_NAME = 'runs';
  const PARTICIPANT_STORE = 'participants';

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'runId' });
          store.createIndex('participantId', 'participantId', { unique: false });
          store.createIndex('testItemId', 'testItemId', { unique: false });
          store.createIndex('testType', 'testType', { unique: false });
          store.createIndex('completedAt', 'completedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(PARTICIPANT_STORE)) {
          const participants = db.createObjectStore(PARTICIPANT_STORE, { keyPath: 'participantId' });
          participants.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function withNamedStore(storeName, mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;
      try { request = action(store); } catch (error) { db.close(); reject(error); return; }
      transaction.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error('数据库事务已中止')); };
    });
  }

  function normalizeParticipant(profile) {
    return {
      participantId: String(profile.participantId || '').trim(),
      sex: String(profile.sex || '').trim(),
      age: profile.age === '' || profile.age == null ? null : Number(profile.age),
      handedness: String(profile.handedness || '').trim(),
      education: String(profile.education || '').trim(),
      notes: String(profile.notes || '').trim()
    };
  }

  async function saveParticipant(profile) {
    const normalized = normalizeParticipant(profile);
    if (!normalized.participantId) throw new Error('被试编号不能为空');
    if (!Number.isInteger(normalized.age) || normalized.age < 1 || normalized.age > 120) throw new Error('年龄须为1至120岁的整数');
    const previous = await getParticipant(normalized.participantId);
    const now = new Date().toISOString();
    const record = { ...normalized, createdAt: previous?.createdAt || now, updatedAt: now };
    await withNamedStore(PARTICIPANT_STORE, 'readwrite', store => store.put(record));
    return record;
  }

  async function listParticipants() {
    const rows = await withNamedStore(PARTICIPANT_STORE, 'readonly', store => store.getAll());
    return (rows || []).sort((a, b) => String(a.participantId).localeCompare(String(b.participantId), 'zh-CN', { numeric: true }));
  }

  async function getParticipant(participantId) {
    return withNamedStore(PARTICIPANT_STORE, 'readonly', store => store.get(String(participantId || '').trim()));
  }

  async function deleteParticipant(participantId) {
    return withNamedStore(PARTICIPANT_STORE, 'readwrite', store => store.delete(String(participantId || '').trim()));
  }

  async function withStore(mode, action) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const store = transaction.objectStore(STORE_NAME);
      let request;
      try { request = action(store); } catch (error) { db.close(); reject(error); return; }
      transaction.oncomplete = () => { db.close(); resolve(request ? request.result : undefined); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error('数据库事务已中止')); };
    });
  }

  function makeRunId(testType, participantId, testItemId) {
    const randomPart = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    return `${testType}_${participantId}_${testItemId}_${Date.now()}_${randomPart}`;
  }

  async function saveRun(run) {
    const profile = run.participantProfile || await getParticipant(run.participantId);
    const record = {
      schemaVersion: 2,
      ...run,
      participantProfile: profile ? normalizeParticipant(profile) : null,
      runId: run.runId || makeRunId(run.testType, run.participantId, run.testItemId),
      savedAt: new Date().toISOString()
    };
    await withStore('readwrite', store => store.put(record));
    return record;
  }

  async function listRuns() {
    const rows = await withStore('readonly', store => store.getAll());
    return (rows || []).sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)));
  }

  async function getRun(runId) {
    return withStore('readonly', store => store.get(runId));
  }

  async function deleteRun(runId) {
    return withStore('readwrite', store => store.delete(runId));
  }

  async function clearRuns() {
    return withStore('readwrite', store => store.clear());
  }

  function quote(value) {
    return `"${String(value ?? '').replace(/"/g, '""')}"`;
  }

  const CSV_HEADERS = [
    '被试编号', '性别', '年龄', '惯用手', '教育程度', '被试备注',
    '测试项目编号', '运行ID', '测试类型', '完成时间', '是否提前结束',
    '总轮次序号', '任务内轮次', '任务', '试次序号', '任务内试次序号', '条件',
    '刺激', '正确反应', '实际反应', '作答方式', '正确', '超时', '反应时_ms',
    '随机等待_ms', 'PVT结果', 'PVT迟缓', 'PVT抢答', '刺激呈现时间', '作答时间'
  ];

  function rowsForRun(run) {
    const profile = run.participantProfile || {};
    const identity = [run.participantId, profile.sex || '', profile.age ?? '', profile.handedness || '', profile.education || '', profile.notes || ''];
    if (run.testType === 'pvtb') {
      return (run.trials || []).map(trial => [
        ...identity, run.testItemId, run.runId, 'PVT-B', run.completedAt, run.aborted ? 1 : 0,
        '', '', 'PVT-B', trial.trialIndex, '', '', '黄色计时器', '尽快响应',
        trial.response || '', trial.responseMethod || '', trial.validResponse ? 1 : 0,
        trial.outcome === 'omission' ? 1 : 0, trial.rtMs ?? '', trial.waitMs ?? '',
        trial.outcome, trial.lapse ? 1 : 0, trial.falseStart ? 1 : 0,
        trial.stimulusAt || '', trial.responseAt || ''
      ]);
    }
    return (run.trials || []).map(trial => [
      ...identity, run.testItemId, run.runId, 'Stroop-Flanker', run.completedAt, run.aborted ? 1 : 0,
      trial.roundIndex, trial.taskRound, trial.type === 'stroop' ? 'Stroop' : 'Flanker',
      trial.index, trial.taskTrial, trial.congruent ? '一致' : '不一致',
      trial.type === 'stroop' ? `${trial.word}/${trial.ink}` : trial.arrows,
      trial.correctResponse, trial.response || '', trial.responseKey || '', trial.correct ? 1 : 0,
      trial.timedOut ? 1 : 0, trial.rtMs ?? '', '', '', '', '', trial.presentedAt, trial.answeredAt
    ]);
  }

  function runsToCsv(runs) {
    const rows = runs.flatMap(rowsForRun);
    return [CSV_HEADERS, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function sampleStandardDeviation(values) {
    if (values.length < 2) return null;
    const average = mean(values);
    const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
  }

  function metric(value) {
    return value == null || !Number.isFinite(value) ? '' : Math.round(value * 100) / 100;
  }

  function pvtRunToCsv(run) {
    const profile = run.participantProfile || {};
    const trials = run.trials || [];
    const validRts = trials.filter(trial => trial.validResponse && Number.isFinite(trial.rtMs)).map(trial => trial.rtMs);
    const rtsAtOrBelow500 = validRts.filter(rt => rt <= 500);
    const lapses = trials.filter(trial => trial.lapse).length;
    const falseStarts = trials.filter(trial => trial.falseStart).length;
    const omissions = trials.filter(trial => trial.outcome === 'omission').length;
    const performanceScore = trials.length ? Math.max(0, 1 - ((lapses + falseStarts) / trials.length)) * 100 : null;

    const infoHeaders = ['被试编号', '性别', '年龄', '惯用手', '教育程度', '被试备注', '测试项目编号', '运行ID', '测试类型', '完成时间', '是否提前结束', '总轮次序号', '任务内轮次', '任务'];
    const infoRow = [run.participantId, profile.sex || '', profile.age ?? '', profile.handedness || '', profile.education || '', profile.notes || '', run.testItemId, run.runId, 'PVT-B', run.completedAt, run.aborted ? 1 : 0, 1, 1, 'PVT-B'];
    const trialHeaders = ['试次序号', '实际反应', '作答方式', '有效反应', '超时', '反应时_ms', '随机等待_ms', 'PVT结果', '迟缓', '抢答', '刺激呈现时间', '作答时间'];
    const trialRows = trials.map(trial => [
      trial.trialIndex, trial.response || '', trial.responseMethod || '', trial.validResponse ? 1 : 0,
      trial.outcome === 'omission' ? 1 : 0, trial.rtMs ?? '', trial.waitMs ?? '', trial.outcome || '',
      trial.lapse ? 1 : 0, trial.falseStart ? 1 : 0, trial.stimulusAt || '', trial.responseAt || ''
    ]);
    const summaryRows = [
      ['总记录事件', trials.length, '全部已完成并计入本次测试的事件'],
      ['有效反应数', validRts.length, '不含抢答和遗漏'],
      ['平均反应时_ms', metric(mean(validRts)), '基于全部有效反应'],
      ['≤500_ms有效反应数', rtsAtOrBelow500.length, '用于剔除>500 ms后的均值'],
      ['剔除>500_ms后的平均反应时_ms', metric(mean(rtsAtOrBelow500)), '仅纳入反应时≤500 ms的有效反应'],
      ['中位数反应时_ms', metric(median(validRts)), '基于全部有效反应'],
      ['反应时标准差_ms', metric(sampleStandardDeviation(validRts)), '样本标准差，基于全部有效反应'],
      ['最快反应时_ms', validRts.length ? Math.min(...validRts) : '', '基于全部有效反应'],
      ['最慢反应时_ms', validRts.length ? Math.max(...validRts) : '', '基于全部有效反应'],
      ['迟缓数', lapses, '反应时≥500 ms'],
      ['抢答数', falseStarts, '刺激前响应或反应时<100 ms'],
      ['遗漏数', omissions, '刺激后超过单题反应窗口未响应'],
      ['综合表现分_%', metric(performanceScore), '100 × [1－(迟缓数＋抢答数)／总记录事件]']
    ];
    const csvRows = [
      ['测试信息'], infoHeaders, infoRow, [],
      ['逐试次数据'], trialHeaders, ...trialRows, [],
      ['统计汇总'], ['指标', '数值', '说明'], ...summaryRows
    ];
    return csvRows.map(row => row.map(quote).join(',')).join('\r\n');
  }

  function safeFilePart(value) {
    return String(value || 'unknown').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50);
  }

  function download(name, content, type) {
    const blob = new Blob(['\ufeff', content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function downloadRunJson(run) {
    const name = `${safeFilePart(run.participantId)}_${safeFilePart(run.testItemId)}_${run.testType}.json`;
    download(name, JSON.stringify(run, null, 2), 'application/json;charset=utf-8');
  }

  function downloadRunCsv(run) {
    const name = `${safeFilePart(run.participantId)}_${safeFilePart(run.testItemId)}_${run.testType}.csv`;
    const content = run.testType === 'pvtb' ? pvtRunToCsv(run) : runsToCsv([run]);
    download(name, content, 'text/csv;charset=utf-8');
  }

  function downloadAllJson(runs, participants) {
    const content = participants ? { schemaVersion: 2, exportedAt: new Date().toISOString(), participants, runs } : runs;
    download(`全部实验结果_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(content, null, 2), 'application/json;charset=utf-8');
  }

  function downloadAllCsv(runs) {
    const content = runs.map((run, index) => {
      const runCsv = run.testType === 'pvtb' ? pvtRunToCsv(run) : runsToCsv([run]);
      return `${['实验记录', index + 1, run.participantId, run.testItemId, run.testType === 'pvtb' ? 'PVT-B' : 'Stroop-Flanker'].map(quote).join(',')}\r\n${runCsv}`;
    }).join('\r\n\r\n');
    download(`全部实验结果_${new Date().toISOString().slice(0, 10)}.csv`, content, 'text/csv;charset=utf-8');
  }

  window.ExperimentStore = {
    saveParticipant,
    listParticipants,
    getParticipant,
    deleteParticipant,
    saveRun,
    listRuns,
    getRun,
    deleteRun,
    clearRuns,
    rowsForRun,
    runsToCsv,
    pvtRunToCsv,
    downloadRunJson,
    downloadRunCsv,
    downloadAllJson,
    downloadAllCsv
  };
})();
