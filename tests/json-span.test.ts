import { expect, it } from 'vitest';
import { jsonPropertySpan } from '../src/json-span';
it('定位嵌套属性时正确跳过字符串、转义、数组和同名属性，不误替换其他设置', () => {
  const raw = JSON.stringify({ setting: { recommendBlockedMids: String.raw`{,"escaped\"}[]` }, array: [{ localCache: 9 }], localCache: { recommendBlockedMids: { '9': '甲' } } });
  const span = jsonPropertySpan(raw, ['localCache', 'recommendBlockedMids'])!;
  expect(raw.slice(span.start, span.end)).toBe('{"9":"甲"}'); expect(jsonPropertySpan(raw, ['missing'])).toBeNull();
});
it('重复键遵循 JSON.parse 的最后一项语义', () => {
  const raw = '{"localCache":{"recommendBlockedMids":{"2":"old"}},"localCache":{"recommendBlockedMids":{"1":"new"}}}';
  const span = jsonPropertySpan(raw, ['localCache', 'recommendBlockedMids'])!;
  expect(raw.slice(span.start, span.end)).toBe('{"1":"new"}');
});
