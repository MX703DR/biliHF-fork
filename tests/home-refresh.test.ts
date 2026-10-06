import { describe, expect, it, vi } from 'vitest';
import { beginHomeRefreshLayoutGuard, createHomeRefreshHandler, guardNativeWebPaging, hasNativeHomeContent, isHomeBrowsingInput, replaceNativeWebFeed } from '../src/home-refresh';

const tick = async () => { for (let i=0; i<8; i++) await Promise.resolve(); };
function harness(selector='.roll-btn') {
  const button={disabled:false}; let enabled=true, home=true, loading=false;
  let done!: (v:boolean)=>void;
  const refresh=vi.fn(()=>new Promise<boolean>(resolve=>{done=resolve;}));
  const reload=vi.fn(), failed=vi.fn();
  const event={button:0,target:{closest:(s:string)=>s===selector?button:null},preventDefault:vi.fn(),stopImmediatePropagation:vi.fn()};
  const handler=createHomeRefreshHandler({enabled:()=>enabled,isHome:()=>home,loading:()=>loading,refresh,reload,failed});
  return {button,event,handler,refresh,reload,failed,click:()=>handler(event as any),finish:(v=true)=>done(v),
    disable:()=>{enabled=false;},elsewhere:()=>{home=false;},loading:()=>{loading=true;}};
}
describe('首页换一换：原站 WEB 登录推荐',()=>{
  it('面板/插件菜单/确认弹窗内部滚动或已被处理的操作不能触发推荐加载',()=>{
    const inside={defaultPrevented:false,target:{closest:()=>({})}};
    expect(isHomeBrowsingInput(inside as any)).toBe(false);
    expect(isHomeBrowsingInput({defaultPrevented:true,target:null} as any)).toBe(false);
    expect(isHomeBrowsingInput({defaultPrevented:false,target:{closest:()=>null}} as any)).toBe(true);
  });
  it('两个刷新入口只提交一次，按钮等待异步完成后恢复',async()=>{
    for(const selector of ['.roll-btn','.flexible-roll-btn-inner']){
      const h=harness(selector);h.click();h.click();await tick();expect(h.refresh).toHaveBeenCalledOnce();
      expect(h.event.stopImmediatePropagation).toHaveBeenCalledTimes(2);if(selector==='.roll-btn')expect(h.button.disabled).toBe(true);
      h.finish();await tick();expect(h.button.disabled).toBe(false);expect(h.reload).not.toHaveBeenCalled();
    }
  });
  it('加载中拒绝连点，不是首页/暂停/非左键/无关入口则完全放行',async()=>{
    const h=harness();h.loading();h.click();await tick();expect(h.refresh).not.toHaveBeenCalled();
    for(const mode of ['disable','elsewhere'] as const){const v=harness();v[mode]();v.click();expect(v.event.preventDefault).not.toHaveBeenCalled();}
    const v=harness();v.handler({...v.event,button:1} as any);v.handler({...v.event,target:{closest:()=>null}} as any);
    expect(v.event.preventDefault).not.toHaveBeenCalled();
  });
  it('缺失受支持的原站 store/组件时只能整页刷新，不回退到匿名或 App API',async()=>{
    const h=harness();h.click();await tick();h.finish(false);await tick();expect(h.reload).toHaveBeenCalledOnce();
  });
  it('请求失败保留页面，不自动再请求、回顶或重载',async()=>{
    const h=harness();h.refresh.mockRejectedValue(new Error('network'));h.click();await tick();
    expect(h.failed).toHaveBeenCalledOnce();expect(h.reload).not.toHaveBeenCalled();expect(h.button.disabled).toBe(false);
  });
});

function feedHarness(empty=false){
  const feed:any={data:{recommend:{item:[]},head:{recommend:[]}},fetch_row:10,noMoreFeed:true,
    fresh_idx:7,fresh_idx_1h:8,brush:{refresh:3},feedReqCardList:['exposure'],clicks:['click'],uniq_id:'same-session',
    initRequest:vi.fn(async()=>{}),getPsParams:vi.fn(()=>({ps:10,domestic_zh_ps:10,overseas_other_ps:15})),
    getHead:vi.fn(async()=>{feed.data.recommend={item:empty?[]:[{title:'新推荐'}]};feed.data.head.recommend=empty?[]:[{title:'新推荐'}];})};
  const deps={reset:vi.fn(async()=>{}),advance:vi.fn(),afterPaint:vi.fn(async()=>{})};return{feed,deps};
}
describe('原站 WEB 推荐会话和原生分页重建',()=>{
  it('仅剩游客登录提示不是推荐内容，但不从原数组删除提示；未知卡片类型保持放行',()=>{
    const head=[{goto:'login_card',title:''}];const feed={data:{head:{recommend:head}}};expect(hasNativeHomeContent(feed)).toBe(false);expect(head).toHaveLength(1);
    head.push({goto:'future_content',title:''});expect(hasNativeHomeContent(feed)).toBe(true);
    expect(hasNativeHomeContent({data:{head:{recommend:[]}}})).toBe(false);expect(hasNativeHomeContent(null)).toBe(false);
  });
  it('刷新中或全过滤时阻止原生延迟分页，不推进会话或发请求；只包装一次',()=>{
    let suspended=true;const original=vi.fn();const feed={updateParams:original};guardNativeWebPaging(feed,()=>suspended);const wrapper=feed.updateParams;
    guardNativeWebPaging(feed,()=>false);expect(feed.updateParams).toBe(wrapper);
    expect(()=>feed.updateParams(4)).toThrow('paging is suspended');expect(original).not.toHaveBeenCalled();expect(feed.updateParams(3)).toBeUndefined();
    suspended=false;feed.updateParams(4);expect(original.mock.calls).toEqual([[3],[4]]);
  });
  it('只请求原站 Change=3，保留列/地区参数和推荐会话；仅重置楼层行号',async()=>{
    const h=feedHarness();const exposed=h.feed.feedReqCardList,brush=h.feed.brush;
    await replaceNativeWebFeed(h.feed,h.deps);
    expect(h.feed.getHead).toHaveBeenCalledExactlyOnceWith({ps:10,domestic_zh_ps:10,overseas_other_ps:15,fresh_type:3,fetch_row:1});
    expect(h.feed.fetch_row).toBe(1);expect(h.feed.noMoreFeed).toBe(false);expect(h.feed.fresh_idx).toBe(7);expect(h.feed.fresh_idx_1h).toBe(8);
    expect(h.feed.feedReqCardList).toBe(exposed);expect(h.feed.brush).toBe(brush);expect(h.feed.uniq_id).toBe('same-session');expect(h.feed.clicks).toEqual(['click']);
    expect(h.deps.advance).toHaveBeenCalledOnce();expect(h.deps.reset).toHaveBeenCalledOnce();expect(h.deps.afterPaint).toHaveBeenCalledOnce();
  });
  it('用户向下浏览空批次时请求 WEB DropDown=4，并保留游标推进而非重置推荐会话',async()=>{
    const h=feedHarness();await replaceNativeWebFeed(h.feed,h.deps,true);
    expect(h.feed.getHead.mock.calls[0][0]).toMatchObject({fresh_type:4,fetch_row:13});expect(h.feed.fetch_row).toBe(10);expect(h.deps.advance).not.toHaveBeenCalled();
  });
  it('原站吞掉网络错误但没有新响应时拒绝重建，也不尝试匿名或 App',async()=>{
    const h=feedHarness();h.feed.getHead.mockImplementation(async()=>{});const previous=h.feed.data.recommend;
    await expect(replaceNativeWebFeed(h.feed,h.deps)).rejects.toThrow('未切换匿名或 App');expect(h.feed.data.recommend).toBe(previous);expect(h.deps.reset).not.toHaveBeenCalled();
  });
  it('全被过滤时重建也不发 Init；重建完成或异常都恢复原 initRequest',async()=>{
    const h=feedHarness(true);const init=h.feed.initRequest;
    h.deps.reset.mockImplementation(async()=>{await h.feed.initRequest();});await replaceNativeWebFeed(h.feed,h.deps);
    expect(init).not.toHaveBeenCalled();expect(h.feed.initRequest).toBe(init);
    h.deps.reset.mockRejectedValue(new Error('reset'));await expect(replaceNativeWebFeed(h.feed,h.deps)).rejects.toThrow('reset');expect(h.feed.initRequest).toBe(init);
  });
});

function style(){
  const values=new Map<string,string>(),priorities=new Map<string,string>();
  return{getPropertyValue:(n:string)=>values.get(n)||'',getPropertyPriority:(n:string)=>priorities.get(n)||'',
    setProperty:(n:string,v:string,p='')=>{values.set(n,v);priorities.set(n,p);},removeProperty:(n:string)=>{values.delete(n);priorities.delete(n);}};
}
describe('刷新布局滚动锚定保护',()=>{
  it('替换期间关闭根和 body 的锚定，恢复原值/优先级且可以重复恢复',()=>{
    const a=style(),b=style();a.setProperty('overflow-anchor','auto');const restore=beginHomeRefreshLayoutGuard({documentElement:{style:a},body:{style:b}} as any);
    expect(a.getPropertyValue('overflow-anchor')).toBe('none');expect(b.getPropertyPriority('overflow-anchor')).toBe('important');
    restore();restore();expect(a.getPropertyValue('overflow-anchor')).toBe('auto');expect(a.getPropertyPriority('overflow-anchor')).toBe('');expect(b.getPropertyValue('overflow-anchor')).toBe('');
  });
  it('其他扩展替换的样式不被覆盖',()=>{
    const a=style();const restore=beginHomeRefreshLayoutGuard({documentElement:{style:a}} as any);a.setProperty('overflow-anchor','auto','important');restore();expect(a.getPropertyValue('overflow-anchor')).toBe('auto');
  });
  it('为非零位置保留至少一屏高度，组件重新挂载后恢复原最小高度',()=>{
    const a=style(),b=style();b.setProperty('min-height','80px');
    const restore=beginHomeRefreshLayoutGuard({documentElement:{style:a},body:{style:b},defaultView:{scrollY:650,innerHeight:1080}} as any);
    expect(b.getPropertyValue('min-height')).toBe('1730px');restore();expect(b.getPropertyValue('min-height')).toBe('80px');
  });
});
