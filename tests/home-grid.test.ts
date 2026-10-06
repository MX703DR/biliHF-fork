import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG, DEFAULT_CONFIG } from '../src/config';
import { rebuildRules } from '../src/match/engine';
import { adaptHomeRender } from '../src/home-grid';
const video = { name: 'BiliVideoCard' };
const floor = {};
const node = (type: any, props: any = {}, children: any = null) => ({ __v_isVNode: true, type, props, children, patchFlag: 64, dynamicChildren: ['old'], key: props.key });
const bone = () => node(video, { skeleton: true });
const floorBone = () => node(floor, { skeleton: '' });
const anchor = () => node('div', { class: 'load-more-anchor', ref: 'observer' }, [floorBone()]);
beforeEach(() => { Object.assign(CONFIG, structuredClone(DEFAULT_CONFIG)); rebuildRules(); });
describe('首页渲染模型适配', () => {
  it('在原生 patch 前填齐隐形楼层骨架，保留加载哨兵 ref 和网格顺序', () => {
    const root = node('div', {}, [bone(), anchor(), floorBone()]);
    const adapted = adaptHomeRender(root);
    expect(adapted.children).toHaveLength(3);
    expect(adapted.children[1].props).toBe(root.children[1].props);
    expect(adapted.children[1].children[0].type).toBe(video);
    expect(adapted.children[2].type).toBe(video);
    expect(root.children[2].type).toBe(floor);
    expect(adapted.dynamicChildren).toBeNull();
    expect(adapted.patchFlag).toBe(-2);
  });
  it('ClientOnly 插槽仍由原生 Vue 调用，适配其返回值，不提前执行', () => {
    let calls = 0;
    const slot = Object.assign(() => { calls++; return [bone(), anchor()]; }, { _c: true, _d: true });
    const root = node({}, {}, { default: slot, _: 1, $stable: true });
    const adapted = adaptHomeRender(root);
    expect(calls).toBe(0); expect(adapted.children.default._c).toBe(true);
    expect(adapted.children._).toBe(2); expect(adapted.children.$stable).toBeUndefined();
    expect(adapted.children.default()[1].children[0].type).toBe(video);
    expect(calls).toBe(1);
  });
  it('命中卡片及其单卡 wrapper 一起从渲染数据删除，不留下空网格单元', () => {
    CONFIG.block.keywords.push('屏蔽'); rebuildRules();
    const root = node('div', {}, [node('div', { class: 'feed-card' }, [node(video, { info: { title: '屏蔽' } })]), node(video, { info: { title: '保留' } })]);
    expect(adaptHomeRender(root).children.map((x: any) => x.props.info.title)).toEqual(['保留']);
  });
  it('楼层卡的子视频本地去重过滤，展示项命中时使用保留项，不改原对象', () => {
    CONFIG.block.uids.push('100'); rebuildRules();
    const first = { title: '屏蔽', author: { mid: 100 } }, second = { title: '保留', author: { mid: 200 } };
    const info = { isFloor: true, list: [first, second], displayItem: first };
    const out = adaptHomeRender(node(floor, { info }));
    expect(out.props.info.list).toEqual([second]); expect(out.props.info.displayItem).toBe(second);
    expect(info.list).toEqual([first, second]);
  });
  it('暂停 / 审查模式不改变原生渲染树', () => {
    const root = node('div', {}, [bone(), anchor()]);
    CONFIG.enabled = false; expect(adaptHomeRender(root)).toBe(root);
    CONFIG.enabled = true; CONFIG.reviewMode = true; expect(adaptHomeRender(root)).toBe(root);
  });
});
