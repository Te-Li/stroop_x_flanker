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
    download(name, runsToCsv([run]), 'text/csv;charset=utf-8');
  }

  function downloadAllJson(runs, participants) {
    const content = participants ? { schemaVersion: 2, exportedAt: new Date().toISOString(), participants, runs } : runs;
    download(`全部实验结果_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(content, null, 2), 'application/json;charset=utf-8');
  }

  function downloadAllCsv(runs) {
    download(`全部实验结果_${new Date().toISOString().slice(0, 10)}.csv`, runsToCsv(runs), 'text/csv;charset=utf-8');
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
    downloadRunJson,
    downloadRunCsv,
    downloadAllJson,
    downloadAllCsv
  };
})();
