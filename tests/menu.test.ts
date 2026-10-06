import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../src/config';
import { onContextMenu, shouldUseNativeContextMenu } from '../src/ui/menu/context';

describe('右键菜单', () => {
  afterEach(() => {
    CONFIG.invertShiftRightClick = false;
  });

  it('默认与反转模式的四种组合互为镜像', () => {
    expect(shouldUseNativeContextMenu(false, false)).toBe(false);
    expect(shouldUseNativeContextMenu(true, false)).toBe(true);
    expect(shouldUseNativeContextMenu(false, true)).toBe(true);
    expect(shouldUseNativeContextMenu(true, true)).toBe(false);
  });

  it('Shift + 右键完全绕过插件菜单并保留浏览器默认行为', () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const composedPath = vi.fn(() => []);
    const event = {
      shiftKey: true,
      preventDefault,
      stopPropagation,
      composedPath,
    } as unknown as MouseEvent;

    onContextMenu(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(composedPath).not.toHaveBeenCalled();
  });

  it('开启反转后，普通右键完全绕过插件菜单', () => {
    CONFIG.invertShiftRightClick = true;
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const composedPath = vi.fn(() => []);
    const event = {
      shiftKey: false,
      preventDefault,
      stopPropagation,
      composedPath,
    } as unknown as MouseEvent;

    onContextMenu(event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(composedPath).not.toHaveBeenCalled();
  });
});
