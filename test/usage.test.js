'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { costOfUsage, costOfProjection, isPeak, PRICING_V2 } = require('../src/usage');

// 北京高峰时段：9-12、14-18。测试用固定时刻：2026-08-18（周三）
// peak ts：北京时间 10:00 = UTC 02:00；offpeak ts：北京时间 20:00 = UTC 12:00
const PEAK_TS = Date.UTC(2026, 7, 18, 2, 0, 0);
const OFFPEAK_TS = Date.UTC(2026, 7, 18, 12, 0, 0);

test('isPeak：北京 9-12 / 14-18 为高峰', () => {
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 1, 0, 0)), true, '09:00 高峰'); // 北京 09:00
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 2, 0, 0)), true, '10:00 高峰'); // 北京 10:00
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 3, 59, 0)), true, '11:59 高峰'); // 北京 11:59
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 4, 0, 0)), false, '12:00 非高峰'); // 北京 12:00
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 6, 0, 0)), true, '14:00 高峰'); // 北京 14:00
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 9, 59, 0)), true, '17:59 高峰'); // 北京 17:59
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 10, 0, 0)), false, '18:00 非高峰'); // 北京 18:00
  assert.strictEqual(isPeak(Date.UTC(2026, 7, 18, 12, 0, 0)), false, '20:00 非高峰'); // 北京 20:00
});

test('costOfUsage：未命中 + 缓存写入都按 miss 单价计（flash 峰谷价）', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 300, outputTokens: 500 };
  // flash offpeak: miss 1.5, hit 0.05, out 4.5（元/百万）
  const off = costOfUsage(usage, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.strictEqual(off, ((1000 + 300) * 1.5 + 2000 * 0.05 + 500 * 4.5) / 1e6);
  // flash peak: miss 3.0, hit 0.1, out 9.0
  const pk = costOfUsage(usage, 'deepseek-v4-flash', PEAK_TS);
  assert.strictEqual(pk, ((1000 + 300) * 3.0 + 2000 * 0.1 + 500 * 9.0) / 1e6);
});

test('costOfUsage：cacheWriteTokens 参与未命中计费（插件口径，勿回归）', () => {
  const withWrite = costOfUsage({ inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS);
  const withoutWrite = costOfUsage({ inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS);
  assert.ok(withWrite > withoutWrite, '缓存写入应计入费用');
  assert.ok(Math.abs(withWrite - withoutWrite - (500 * 1.5) / 1e6) < 1e-12);
});

test('costOfUsage：pro 用 pro 价，未知模型按 flash 计', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000 };
  const pro = costOfUsage(usage, 'deepseek-v4-pro', OFFPEAK_TS);
  assert.ok(Math.abs(pro - (1000 * 4.5 + 1000 * 13.5) / 1e6) < 1e-12);
  const unknown = costOfUsage(usage, 'some-other-model', OFFPEAK_TS);
  assert.ok(Math.abs(unknown - (1000 * 1.5 + 1000 * 4.5) / 1e6) < 1e-12);
});

test('costOfProjection：整会话投影费用与插件 computeCost 同口径', () => {
  // 真实会话投影量级（flash，20:00 北京 offpeak）
  const tu = { uncachedInputTokens: 3212839, outputTokens: 1618497, cacheReadTokens: 1065428352, cacheWriteTokens: 0 };
  const c = costOfProjection(tu, 'deepseek-v4-flash', OFFPEAK_TS);
  const hit = (1065428352 * 0.05) / 1e6;
  const miss = (3212839 * 1.5) / 1e6;
  const out = (1618497 * 4.5) / 1e6;
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
  assert.ok(Math.abs(c.total - (1500 * 1.5) / 1e6) < 1e-12);
});

test('costOfProjection：全零/缺失投影 → 0 费用', () => {
  assert.strictEqual(costOfProjection(null, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
  assert.strictEqual(costOfProjection({}, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
  assert.strictEqual(costOfProjection({ uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, 'deepseek-v4-flash', OFFPEAK_TS).total, 0);
});

test('PRICING_V2：flash/pro 峰谷价与插件 TIERED_PRICES 一致', () => {
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-flash'].peak, { hit: 0.1, miss: 3.0, out: 9.0 });
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-flash'].offpeak, { hit: 0.05, miss: 1.5, out: 4.5 });
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-pro'].peak, { hit: 0.3, miss: 9.0, out: 27.0 });
  assert.deepStrictEqual(PRICING_V2['deepseek-v4-pro'].offpeak, { hit: 0.15, miss: 4.5, out: 13.5 });
});
