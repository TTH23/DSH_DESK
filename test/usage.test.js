'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { costOfUsage, costOfProjection, isPeak, isHoliday, peakLabel, PRICING_V2 } = require('../src/usage');

// 峰谷规则（官方最新）：高峰 = 周一至周五（不含法定节假日）北京 9:00-12:00 / 14:00-18:00；
// 周末与法定节假日全天空闲。
// 2026-08-18 是周二 → peak ts：北京 10:00 = UTC 02:00；offpeak ts：北京 20:00 = UTC 12:00
const PEAK_TS = Date.UTC(2026, 7, 18, 2, 0, 0);
const OFFPEAK_TS = Date.UTC(2026, 7, 18, 12, 0, 0);
// 2026-08-22 是周六、2026-08-23 是周日
const SAT_TS = Date.UTC(2026, 7, 22, 2, 0, 0); // 周六北京 10:00（应为空闲）
const SUN_TS = Date.UTC(2026, 7, 23, 2, 0, 0); // 周日北京 10:00（应为空闲）
// 2026-10-01 国庆（周四），北京 10:00 应为空闲
const HOLIDAY_TS = Date.UTC(2026, 9, 1, 2, 0, 0);

test('isPeak：工作日北京 9-12 / 14-18 为高峰', () => {
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 1, 0, 0)), true, '周二 09:00 高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 2, 0, 0)), true, '周二 10:00 高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 3, 59, 0)), true, '周二 11:59 高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 4, 0, 0)), false, '周二 12:00 非高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 6, 0, 0)), true, '周二 14:00 高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 9, 59, 0)), true, '周二 17:59 高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 10, 0, 0)), false, '周二 18:00 非高峰');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 12, 0, 0)), false, '周二 20:00 非高峰');
});

test('isPeak：周末全天空闲（即使处在 9-12/14-18）', () => {
  assert.strictEqual(isPeak(SAT_TS), false, '周六 10:00 空闲');
  assert.strictEqual(isPeak(SUN_TS), false, '周日 10:00 空闲');
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 22, 6, 0, 0)), false, '周六 14:00 空闲');
});

test('isPeak：法定节假日全天空闲（国庆 2026-10-01 周四）', () => {
  assert.strictEqual(isHoliday(HOLIDAY_TS), true, '10-01 是法定节假日');
  assert.strictEqual(isPeak(HOLIDAY_TS), false, '节假日 10:00 空闲');
  assert.strictEqual(isPeak(Date.UTC(2026, 9, 5, 2, 0, 0)), false, '10-05 周一（假期内）空闲');
});

test('peakLabel：区分高峰 / 空闲（周末）/ 空闲（节假日）/ 空闲', () => {
  assert.deepStrictEqual(peakLabel(PEAK_TS), { peak: true, text: '高峰' });
  assert.deepStrictEqual(peakLabel(OFFPEAK_TS), { peak: false, text: '空闲' });
  assert.deepStrictEqual(peakLabel(SAT_TS), { peak: false, text: '空闲（周末）' });
  assert.deepStrictEqual(peakLabel(HOLIDAY_TS), { peak: false, text: '空闲（节假日）' });
});

test('costOfUsage：未命中 + 缓存写入都按 miss 单价计（flash 新峰谷价）', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 300, outputTokens: 500 };
  // flash 空闲：miss 1, hit 0.02, out 4（元/百万）
  const off = costOfUsage(usage, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.strictEqual(off, ((1000 + 300) * 1.0 + 2000 * 0.02 + 500 * 4.0) / 1e6);
  // flash 高峰：miss 2, hit 0.04, out 8
  const pk = costOfUsage(usage, 'deepseek-v4-flash', PEAK_TS);
  assert.strictEqual(pk, ((1000 + 300) * 2.0 + 2000 * 0.04 + 500 * 8.0) / 1e6);
});

test('costOfUsage：模型名 deepseek-flash（新正式名）与旧名同价', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 1000, cacheWriteTokens: 0, outputTokens: 1000 };
  const newName = costOfUsage(usage, 'deepseek-flash', OFFPEAK_TS);
  const oldName = costOfUsage(usage, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.strictEqual(newName, oldName, 'deepseek-flash 与 deepseek-v4-flash 同价');
  const historic = costOfUsage(usage, 'deepseek-v4-flash-vision-exp', OFFPEAK_TS);
  assert.strictEqual(historic, oldName, '旧视觉模型名也按 flash 计');
});

test('costOfUsage：cacheWriteTokens 参与未命中计费（插件口径，勿回归）', () => {
  const withWrite = costOfUsage({ inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS);
  const withoutWrite = costOfUsage({ inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.ok(withWrite > withoutWrite, '缓存写入应计入费用');
  assert.ok(Math.abs(withWrite - withoutWrite - (500 * 1.0) / 1e6) < 1e-12);
});

test('costOfUsage：pro 用 pro 价，未知模型按 flash 计', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 };
  const pro = costOfUsage(usage, 'deepseek-v4-pro', OFFPEAK_TS);
  assert.ok(Math.abs(pro - (1000 * 4.5 + 1000 * 13.5) / 1e6) < 1e-12);
  const unknown = costOfUsage(usage, 'some-other-model', OFFPEAK_TS);
  assert.ok(Math.abs(unknown - (1000 * 1.0 + 1000 * 4.0) / 1e6) < 1e-12);
});

test('costOfProjection：整会话投影费用（flash 新价）', () => {
  // 真实会话投影量级（flash，20:00 北京 offpeak）
  const tu = { uncachedInputTokens: 3212839, outputTokens: 1618497, cacheReadTokens: 1065428352, cacheWriteTokens: 0 };
  const c = costOfProjection(tu, 'deepseek-v4-flash', OFFPEAK_TS);
  const hit = (1065428352 * 0.02) / 1e6;
  const miss = (3212839 * 1.0) / 1e6;
  const out = (1618497 * 4.0) / 1e6;
  assert.ok(Math.abs(c.hit - hit) < 1e-9);
  assert.ok(Math.abs(c.miss - miss) < 1e-9);
  assert.ok(Math.abs(c.out - out) < 1e-9);
  assert.ok(Math.abs(c.total - (hit + miss + out)) < 1e-9);
  // 未定义模型 → flash
  const def = costOfProjection(tu, null, OFFPEAK_TS);
  assert.strictEqual(def.total, c.total);
});

test('costOfProjection：cacheWriteTokens 计入未命中费用（插件口径）', () => {
  const tu = { uncachedInputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 0, outputTokens: 0 };
  const c = costOfProjection(tu, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.ok(Math.abs(c.total - (1500 * 1.0) / 1e6) < 1e-12);
});

test('costOfProjection：全零/缺失投影 → 0 费用', () => {
  assert.strictEqual(costOfProjection(null, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
  assert.strictEqual(costOfProjection({}, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
  assert.strictEqual(costOfProjection({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
});

test('PRICING_V2：与官方最新价格表一致（flash 空闲/高峰、pro 空闲/高峰）', () => {
  // flash：命中 0.02/0.04、未命中 1/2、输出 4/8
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-flash'].offpeak, { hit: 0.02, miss: 1.0, out: 4.0 });
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-flash'].peak, { hit: 0.04, miss: 2.0, out: 8.0 });
  // pro：命中 0.15/0.30、未命中 4.5/9、输出 13.5/27
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-pro'].offpeak, { hit: 0.15, miss: 4.5, out: 13.5 });
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-pro'].peak, { hit: 0.3, miss: 9.0, out: 27.0 });
  // 空闲价 = 高峰价一半（官方规则）
  for (const k of Object.keys(PRICING_V2)) {
    const t = PRICING_V2[k];
    assert.strictEqual(t.offpeak.hit * 2, t.peak.hit, `${k} hit 空闲价应为高峰一半`);
    assert.strictEqual(t.offpeak.miss * 2, t.peak.miss, `${k} miss 空闲价应为高峰一半`);
    assert.strictEqual(t.offpeak.out * 2, t.peak.out, `${k} out 空闲价应为高峰一半`);
  }
});
